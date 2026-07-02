/**
 * Build runner for TeX projects.
 *
 * Runs the build pipeline as child processes:
 *   1. latexmk → DVI + synctex
 *   2. Publish <texBase>.dvi to output/, clear stale SVGs, signal reload
 *   3. extract-preamble.js → macros.json
 *   4. extract-synctex-lookup.mjs → lookup.json
 *   5. compute-proof-pairing.mjs → proof-info.json
 *
 * SVG pages are built on demand by buildCurrentPage() (shadow-repo.mjs) when
 * the client requests them. The build never runs dvisvgm — ensure does.
 * Each step writes output to server/projects/{name}/output/.
 */

import { exec as execCb, execSync, spawn } from 'child_process'
import { promisify } from 'util'
const _execAsync = promisify(execCb)
// Ensure TeX binaries are available (launchd doesn't inherit full shell PATH).
// Check common TeX locations across platforms.
for (const texbin of ['/Library/TeX/texbin', '/usr/local/texlive/2024/bin/x86_64-linux', '/usr/local/texlive/2025/bin/x86_64-linux']) {
  if (!process.env.PATH?.includes(texbin)) {
    try { if (statSync(texbin).isDirectory()) process.env.PATH = `${texbin}:${process.env.PATH || '/usr/bin:/bin'}` }
    catch {}
  }
}
const execAsync = (cmd, opts = {}) => _execAsync(cmd, { maxBuffer: 50 * 1024 * 1024, ...opts })

async function _gitRetryOnLock(fn, retries = 3, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try { return await fn() }
    catch (err) {
      if (i < retries - 1 && /index\.lock|Unable to create.*lock|cannot lock ref|unable to update local ref/i.test(err.message)) {
        await new Promise(r => setTimeout(r, delayMs))
        continue
      }
      throw err
    }
  }
}
import { existsSync, readdirSync, writeFileSync, readFileSync, unlinkSync, renameSync, mkdirSync, cpSync, rmSync, statSync, realpathSync } from 'fs'
import { createHash } from 'crypto'
import { join, basename, dirname } from 'path'
import { tmpdir, homedir } from 'os'
import { fileURLToPath } from 'url'
import { updateProject, sourceDir, outputDir, projectDir, readProject, listProjects, extractBuildErrors } from './project-store.mjs'
import { broadcastSignal, putShape, updateShape, emitGlobalEvent } from './sync-rooms.mjs'
import { writeSentinel } from './sentinel.mjs'
import { snapshotBeforeBuild, recordGitSnapshot } from './history-store.mjs'
import { commitSnapshot, currentVersion, initShadowFromProjectRepo, createShadowBundleBase64 } from './shadow-repo.mjs'
import { appendBuildEntry } from './changelog.mjs'
import { emitBuildComplete } from './webhooks.mjs'
import { clearSynctexCache } from './synctex-query.mjs'

// --- Side-effect reporter ----------------------------------------------------
// Everything in the build that reaches the live server — client broadcasts
// (sync-rooms) and project.json writes — goes through this indirection so the
// pipeline can run in a separate process. In the server, the default reporter
// calls the real functions directly. In a forked build-worker, setBuildReporter
// swaps these for IPC sends back to the server, which performs them there.
// All four are fire-and-forget (no return value) → clean to ship over IPC.
const _directReporter = {
  broadcastSignal: (room, signal, payload) => broadcastSignal(room, signal, payload),
  putShape: (docName, shape) => putShape(docName, shape),
  writeSentinel: (docName, propsPatch) => writeSentinel(docName, propsPatch),
  patchShape: async (docName, shapeId, propsPatch) => {
    try {
      await updateShape(docName, shapeId, cur => ({
        ...cur,
        props: { ...(cur.props || {}), ...(propsPatch || {}) },
      }))
    } catch (e) {
      if (!/not found/i.test(e?.message || '')) throw e
      await putShape(docName, {
        id: shapeId,
        typeName: 'shape',
        type: 'doc-version',
        x: 0,
        y: 0,
        rotation: 0,
        index: 'a0',
        parentId: 'page:page',
        isLocked: true,
        opacity: 0,
        meta: {},
        props: {
          w: 1,
          h: 1,
          commitHash: 'unknown',
          timestamp: Date.now(),
          buildReadyAt: Date.now(),
          warningsJson: '',
          errorsJson: '',
          syncErrorJson: '',
          ...(propsPatch || {}),
        },
      })
    }
  },
  emitGlobalEvent: (type, payload) => emitGlobalEvent(type, payload),
  updateProject: (name, patch) => updateProject(name, patch),
}
let _reporter = _directReporter
export function setBuildReporter(r) { _reporter = r || _directReporter }

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..', '..')
const SCRIPTS_DIR = join(PROJECT_ROOT, 'scripts')
const DOC_VERSION_SENTINEL_ID = 'shape:doc-version--sentinel'

let mirrorShadowSnapshot = null

export function setShadowMirrorHandler(handler) {
  mirrorShadowSnapshot = typeof handler === 'function' ? handler : null
}

function convertScratchMarkdown(srcDir, addLog) {
  const scratchDir = join(srcDir, '.tlda', 'scratch')
  if (!existsSync(scratchDir)) return
  let converted = 0
  for (const f of readdirSync(scratchDir)) {
    if (!f.endsWith('.md')) continue
    const mdPath = join(scratchDir, f)
    const texPath = join(scratchDir, f.replace(/\.md$/, '.tex'))
    const mdContent = readFileSync(mdPath, 'utf8')
    let texContent = mdContent.replace(/(?<![\\@\w])@([\w:.-]+[\w])/g, '\\ref{$1}')
    try {
      texContent = execSync('pandoc -f markdown -t latex --wrap=none', { input: texContent, encoding: 'utf8', timeout: 10000 })
    } catch (e) {
      const stderr = (e.stderr || '').toString()
      const msg = (stderr || e.message || 'unknown error').slice(0, 800)
      const sanitized = msg.replace(/[\\{}#%&^_~$]/g, '?').replace(/\n/g, ' / ')
      const errTex = `\\par\\noindent\\fbox{\\footnotesize\\ttfamily [scratch: pandoc failed for ${sanitized.slice(0, 200)} — check source]}\\par\n`
      writeFileSync(texPath, errTex)
      addLog(`pandoc failed for ${f}: ${e.message} — wrote warning marker to ${texPath}`)
      continue
    }
    if (!texContent.endsWith('\n')) texContent += '\n'
    writeFileSync(texPath, texContent)
    converted++
  }
  if (converted > 0) addLog(`Converted ${converted} markdown scratch file(s) to LaTeX`)
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Hash SVG content for change detection. Strips non-deterministic parts:
 * - <style> blocks (WOFF2 font data varies between dvisvgm runs)
 * - xlink:href attributes (contain temp build dir paths)
 */
function hashSvgContent(svgText) {
  const stripped = svgText
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
    .replace(/xlink:href='[^']*'/g, '')
  return createHash('md5').update(stripped).digest('hex')
}

/** Strip leading zeros from dvisvgm page numbers: page-01.svg → page-1.svg */
function normalizeSvgNames(dir) {
  for (const f of readdirSync(dir)) {
    const m = f.match(/^page-0+(\d+\.svg)$/)
    if (m) renameSync(join(dir, f), join(dir, `page-${m[1]}`))
  }
}

/** Atomically publish a file: copy to dest.tmp, then rename into place. */
function publishFile(src, dest) {
  const tmp = dest + '.tmp'
  cpSync(src, tmp)
  renameSync(tmp, dest)
}

/**
 * Generate stub PDFs from SVG figures so LaTeX draft mode reads correct dimensions.
 * For each .svg file, creates a minimal PDF (just a MediaBox) with matching dimensions.
 * Only creates a PDF if one doesn't already exist or is older than the SVG.
 */
function generateStubPdfs(buildDir, addLog) {
  let count = 0
  const svgFiles = findSvgFigures(buildDir)
  for (const svgPath of svgFiles) {
    const pdfPath = svgPath.replace(/\.svg$/, '.pdf')
    // Always generate stub from SVG dimensions — never trust existing PDFs.
    // Real figure PDFs may have wrong/unreadable MediaBox (e.g. corrupted cairo output).
    // Parse SVG dimensions
    const head = readFileSync(svgPath, 'utf8').slice(0, 500)
    let w, h
    const vbMatch = head.match(/viewBox=['"]([^'"]+)['"]/)
    if (vbMatch) {
      const parts = vbMatch[1].split(/\s+/).map(Number)
      w = parts[2]; h = parts[3]
    } else {
      const wm = head.match(/width=['"]([.\d]+)/)
      const hm = head.match(/height=['"]([.\d]+)/)
      if (wm && hm) { w = parseFloat(wm[1]); h = parseFloat(hm[1]) }
    }
    if (!w || !h) continue
    // Write minimal PDF with correct xref byte offsets so pdflatex can read the MediaBox.
    // Hardcoded offsets break when w/h vary in length — compute them dynamically.
    const obj1 = '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
    const obj2 = '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
    const obj3 = `3 0 obj<</Type/Page/MediaBox[0 0 ${w} ${h}]/Parent 2 0 R>>endobj\n`
    const hdr = '%PDF-1.0\n'
    const off1 = hdr.length
    const off2 = off1 + obj1.length
    const off3 = off2 + obj2.length
    const xrefOffset = off3 + obj3.length
    const pad = (n) => String(n).padStart(10, '0')
    const pdf = hdr + obj1 + obj2 + obj3 +
      `xref\n0 4\n0000000000 65535 f \n${pad(off1)} 00000 n \n${pad(off2)} 00000 n \n${pad(off3)} 00000 n \n` +
      `trailer<</Size 4/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`
    writeFileSync(pdfPath, pdf)
    // Write .bb file for graphicx in DVI mode — latex cannot read PDF MediaBox,
    // so without this it falls back to a square placeholder (width × width).
    const bbPath = svgPath.replace(/\.svg$/, '.bb')
    const bb = `%%BoundingBox: 0 0 ${Math.ceil(w)} ${Math.ceil(h)}\n%%HiResBoundingBox: 0.0 0.0 ${w} ${h}\n`
    writeFileSync(bbPath, bb)
    count++
  }
  if (count > 0) addLog(`Generated ${count} stub PDF(s) + .bb files from SVG figures`)
}

/** Recursively find .svg files in a directory (skipping node_modules, hidden dirs). */
function findSvgFigures(dir) {
  const results = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...findSvgFigures(full))
      } else if (entry.name.endsWith('.svg')) {
        results.push(full)
      }
    }
  } catch (e) { console.warn(`[build] SVG figure discovery I/O error in ${dir}: ${e.message}`) }
  return results
}

/** Hash the actual published SVGs on disk — no cached JSON that can drift. */
function loadPageHashes(outDir) {
  const hashes = {}
  try {
    for (const f of readdirSync(outDir)) {
      if (/^page-\d+\.svg$/.test(f)) {
        hashes[f] = hashSvgContent(readFileSync(join(outDir, f), 'utf8'))
      }
    }
  } catch (e) { if (e.code !== 'ENOENT') console.warn(`[build] page hash loading error in ${outDir}: ${e.message}`) }
  return hashes
}

// ─── Build state management ──────────────────────────────────────────────────

// Active builds tracked in memory
const activeBuilds = new Map()

// Per-project build lock: prevents concurrent runBuild for the same project.
// When a build is running and a new one is requested, the new one waits for
// the current one to finish (after killing it), ensuring no orphaned processes.
const _buildLocks = new Map()  // name → Promise

// Monotonic version counter per doc. Incremented when a build starts.
// The mirror callback captures its version and skips if superseded.
const buildVersion = new Map()

export function getBuildStatus(name) {
  return activeBuilds.get(name) || null
}

/**
 * Reset any projects stuck in "building" state (e.g. after server restart mid-build).
 * Call once at startup.
 */
export function resetStaleBuildStates() {
  for (const project of listProjects()) {
    if (project.buildStatus === 'building') {
      console.log(`[build] Resetting stale "building" state for ${project.name}`)
      _reporter.updateProject(project.name, { buildStatus: 'stale' })
    }
  }
}

// Track active child processes per build instance.
// Keyed by unique build ID (not project name) to avoid race conditions
// when a new build starts while the old one's finally block is still running.
const buildChildProcesses = new Map() // buildId → Set<ChildProcess>

let buildIdCounter = 0

/**
 * Run a command, tracking the child process for cleanup.
 * Uses detached mode so we can kill the entire process group on abort.
 */
function trackedExec(buildId, cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execCb(cmd, { maxBuffer: 50 * 1024 * 1024, detached: true, ...opts }, (err, stdout, stderr) => {
      const children = buildChildProcesses.get(buildId)
      if (children) children.delete(child)
      if (err) reject(err)
      else resolve({ stdout, stderr })
    })
    if (!buildChildProcesses.has(buildId)) buildChildProcesses.set(buildId, new Set())
    buildChildProcesses.get(buildId).add(child)
  })
}

/**
 * Kill all child processes for a build instance.
 * Uses negative PID to kill the entire process group (shell + latexmk + pdflatex).
 */
function killBuildProcesses(buildId) {
  const children = buildChildProcesses.get(buildId)
  if (!children) return
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
  }
  children.clear()
  buildChildProcesses.delete(buildId)
}

/**
 * Kill all active build processes across all builds. Used during shutdown.
 */
export function killAllBuilds() {
  for (const [buildId] of buildChildProcesses) {
    killBuildProcesses(buildId)
  }
}

// ─── Build phases ────────────────────────────────────────────────────────────

/**
 * Phase 1: LaTeX compilation.
 * Copies source into a fresh build dir, seeds with cached .aux/.bbl,
 * runs latexmk, preserves the log, and signals build errors immediately.
 */
// Pretex commands injected before \documentclass.
// draft mode for graphicx (placeholder boxes instead of images),
// hypertex driver for hyperref, and ensure hyperref loads.
// DeclareGraphicsRule tells dvips driver (used by pdflatex --output-format=dvi)
// to read bounding box for .pdf files from the .bb companion file we generate.
// Without this, dvips falls back to width×width square placeholders.
const PRETEX = '\\PassOptionsToPackage{draft}{graphics}\\PassOptionsToPackage{draft}{graphicx}\\PassOptionsToPackage{hypertex,hidelinks}{hyperref}\\AddToHook{begindocument/before}{\\RequirePackage{hyperref}}\\AddToHook{package/graphicx/after}{\\DeclareGraphicsRule{.pdf}{eps}{.bb}{}}'

/**
 * Extract preamble from a .tex file (everything before \begin{document}).
 * Returns the preamble text, or null if \begin{document} not found.
 */
function extractPreamble(texPath) {
  const src = readFileSync(texPath, 'utf8')
  const idx = src.search(/^\s*\\begin\s*\{document\}/m)
  if (idx < 0) return null
  return src.slice(0, idx)
}

/**
 * Ensure a precompiled .fmt exists for the project's preamble.
 * Returns the format base name if available, null otherwise.
 *
 * The .fmt bakes in PRETEX + all preamble packages/macros, so subsequent
 * builds skip ~3s of package loading.
 */
async function ensureFormat(ctx) {
  const { srcDir, buildDir, projDir, texBase, texPath, addLog, run } = ctx
  const cacheDir = join(projDir, 'build-cache')

  const preamble = extractPreamble(ctx.texPath)
  if (!preamble) {
    addLog('Could not extract preamble — skipping format')
    return null
  }

  // Hash preamble + pretex to detect changes
  const preambleHash = createHash('md5').update(PRETEX + '\n' + preamble).digest('hex')
  const fmtBase = `${texBase}-fmt`
  const fmtFile = join(cacheDir, `${fmtBase}.fmt`)
  const hashFile = join(cacheDir, 'fmt-hash.txt')

  // Check if cached format matches
  let cachedHash = null
  try { cachedHash = readFileSync(hashFile, 'utf8').trim() } catch {}

  if (cachedHash === preambleHash && existsSync(fmtFile)) {
    cpSync(fmtFile, join(buildDir, `${fmtBase}.fmt`))
    addLog('Using cached format')
    return fmtBase
  }

  // Build new format: write .hdr with pretex + preamble + \endofdump
  addLog('Building preamble format...')
  const fmtStart = Date.now()
  const hdrContent = PRETEX + '\n' + preamble + '\\csname endofdump\\endcsname\n'
  writeFileSync(join(buildDir, `${fmtBase}.hdr`), hdrContent)

  try {
    await run(
      `pdflatex -ini -interaction=nonstopmode -output-format=dvi ` +
      `-jobname="${fmtBase}" "&pdflatex" mylatexformat.ltx "${fmtBase}.hdr"`,
      { cwd: buildDir, timeout: 60000 },
    )
  } catch (e) {
    addLog(`Format creation failed: ${e.message.split('\n')[0]}`)
    return null
  }

  if (!existsSync(join(buildDir, `${fmtBase}.fmt`))) {
    addLog('Format file not created — falling back to direct compilation')
    return null
  }

  addLog(`Format built in ${((Date.now() - fmtStart) / 1000).toFixed(1)}s`)

  // Cache the format + hash
  mkdirSync(cacheDir, { recursive: true })
  cpSync(join(buildDir, `${fmtBase}.fmt`), fmtFile)
  writeFileSync(hashFile, preambleHash)

  return fmtBase
}

/**
 * Phase 1: LaTeX compilation.
 * Runs pdflatex with source dir as cwd and -output-directory to the build dir.
 * No source file copying — pdflatex reads .tex from source, writes .dvi/.log/.aux
 * to the build dir. Cached .aux/.bbl/.fmt seeded into build dir from build-cache.
 */
// Biber ships as a PAR-packed binary that unpacks its Perl runtime + Unicode
// tables into a cache dir. That cache can corrupt, after which biber crashes
// silently (exit 2) mid-decode and emits a 0-byte .bbl — so every \cite renders
// undefined. We point PAR_GLOBAL_TEMP at a per-project dir (see biberParCacheDir)
// so each doc gets its own isolated cache: a corrupt cache can be cleared for
// that one doc without touching any other in-flight build's cache. Removing the
// dir forces biber to re-extract a fresh copy on the next run (~10s one-time;
// warm reuse is the same speed as a shared global cache).
function biberParCacheDir(projDir) {
  return join(projDir, '.biber-par-cache')
}
function clearBiberParCache(parCacheDir, addLog) {
  try {
    rmSync(parCacheDir, { recursive: true, force: true })
    addLog('Cleared this project’s biber PAR cache (biber will re-extract)')
  } catch (e) {
    addLog(`Could not clear biber PAR cache ${parCacheDir}: ${e.message}`)
  }
}

async function compileLaTeX(ctx) {
  const { name, srcDir, buildDir, projDir, texBase, texDir, addLog, run } = ctx
  const cacheDir = join(projDir, 'build-cache')

  // Seed build dir with cached state (.aux, .bbl, .fmt) from last build
  if (existsSync(cacheDir)) {
    for (const f of readdirSync(cacheDir)) {
      cpSync(join(cacheDir, f), join(buildDir, f))
    }
  }

  // Generate stub PDFs in the source dir so LaTeX draft mode reads correct dimensions.
  // Image pipeline: SVG is the authoritative figure format.
  //   1. generateStubPdfs() creates minimal PDFs from SVG dimensions
  //   2. pdflatex runs in draft mode — reads stub PDFs for bounding boxes
  //   3. dvisvgm converts DVI → SVG pages with placeholder boxes
  //   4. patch-svg-images.mjs replaces placeholders with actual SVG content
  // Do NOT use dvipdfmx driver — it requires .xbb files, causing corrupt DVI.
  generateStubPdfs(texDir, addLog)
  if (texDir !== srcDir) generateStubPdfs(srcDir, addLog)

  // Try to use precompiled preamble format
  const fmtBase = await ensureFormat(ctx)

  // TEXMFOUTPUT lets pdflatex write to buildDir even with cwd=srcDir.
  // TEXINPUTS ensures pdflatex finds .aux/.bbl in buildDir alongside srcDir.
  const env = {
    ...process.env,
    TEXMFOUTPUT: buildDir,
    TEXINPUTS: `${buildDir}:${texDir}:${srcDir}:`,
  }

  // Per-project biber PAR cache. PAR_GLOBAL_TEMP makes biber unpack its runtime
  // into this doc's own dir, so a corrupt cache is isolated to one project and
  // recovery can clear it without disturbing concurrent builds of other docs.
  const parCacheDir = biberParCacheDir(projDir)
  mkdirSync(parCacheDir, { recursive: true })
  const biberEnv = {
    ...process.env,
    PAR_GLOBAL_TEMP: parCacheDir,
    BIBINPUTS: `${texDir}:${srcDir}:`,
  }

  // Override the scratch-template for THIS build. The user's source dir has
  // the marker version of \inputscratch (so local vanilla-latex builds show
  // a visible placeholder per scratch section); the build runner writes a
  // version into buildDir/.tlda/scratch/ that actually \input{}s the scratch
  // content. TEXINPUTS lists buildDir first, so pdflatex resolves
  // \input{.tlda/scratch/scratch-template} from here, not srcDir.
  const buildScratchDir = join(buildDir, '.tlda', 'scratch')
  mkdirSync(buildScratchDir, { recursive: true })
  // Scan scratch dir for .tex files and generate per-label mappings so the
  // macro can resolve label → internal path without string manipulation packages.
  const srcScratchDir = join(srcDir, '.tlda', 'scratch')
  const labelMappings = []
  if (existsSync(srcScratchDir)) {
    for (const f of readdirSync(srcScratchDir)) {
      if (!f.endsWith('.tex') || f === 'scratch-template.tex') continue
      const label = 'scratch:' + f.replace(/^scratch-/, '').replace(/\.tex$/, '')
      labelMappings.push(`\\@namedef{tlda@scratch@${label}}{.tlda/scratch/${f}}`)
    }
  }
  writeFileSync(join(buildScratchDir, 'scratch-template.tex'),
    '% scratch-template — server-build override\n' +
    '% #1 = agent file path (display only), #2 = label, #3 = header\n' +
    '\\usepackage{xcolor}\n' +
    '\\makeatletter\n' +
    '\\newcommand{\\inputscratch}[3]{%\n' +
    '  \\@ifundefined{tlda@scratch@#2}{%\n' +
    '    \\par\\noindent\\fbox{\\footnotesize\\ttfamily [scratch: unknown label \\detokenize{#2}]}\\par\n' +
    '  }{%\n' +
    '    \\begingroup\\synctex=1\\color[gray]{0.3}\\par\\noindent{\\footnotesize\\ttfamily[#3]}\\par\\label{#2}\\input{\\csname tlda@scratch@#2\\endcsname}\\endgroup\\par\n' +
    '  }%\n' +
    '}\n' +
    (labelMappings.length > 0 ? labelMappings.join('\n') + '\n' : '') +
    '\\makeatother\n'
  )

  // Build the pdflatex command — cwd is srcDir, output goes to buildDir.
  // -recorder emits <jobname>.fls listing every file read (INPUT) and
  // written (OUTPUT); we parse it after a successful build to populate
  // the project's relevant-files set, which the server uses to filter
  // source-change events.
  let cmd
  if (fmtBase) {
    cmd = `pdflatex --output-format=dvi -synctex=1 -recorder -interaction=nonstopmode ` +
      `-output-directory="${buildDir}" -fmt="${fmtBase}" "${texBase}.tex"`
  } else {
    addLog('No format available — using pretex wrapper')
    const wrapperContent = PRETEX + '\n\\input{' + texBase + '.tex}\n'
    writeFileSync(join(buildDir, `${texBase}-wrapped.tex`), wrapperContent)
    cmd = `pdflatex --output-format=dvi -synctex=1 -recorder -interaction=nonstopmode ` +
      `-output-directory="${buildDir}" -jobname="${texBase}" "${texBase}-wrapped.tex"`
  }

  const compileStart = Date.now()
  addLog(`Compiling${fmtBase ? ' (fmt)' : ''}...`)
  try {
    await run(cmd, { cwd: texDir, timeout: 120000, env })
  } catch (e) {
    addLog(`pdflatex exited with warnings (continuing): ${e.message.split('\n')[0]}`)
  }

  // Check if bibliography processing is needed (missing .bbl or undefined citations)
  const bblPath = join(buildDir, `${texBase}.bbl`)
  const bcfPath = join(buildDir, `${texBase}.bcf`)
  const logPath = join(buildDir, `${texBase}.log`)
  if (existsSync(logPath)) {
    const logText = readFileSync(logPath, 'utf8')
    const hasBrokenCites = !existsSync(bblPath) ||
      (logText.includes('Citation') && logText.includes('undefined'))
    if (hasBrokenCites) {
      const useBiblatex = existsSync(bcfPath)
      const bibCmd = useBiblatex
        ? `biber --output-directory="${buildDir}" "${texBase}"`
        : `BIBINPUTS="${texDir}:${srcDir}:" BSTINPUTS="${texDir}:${srcDir}:" bibtex "${texBase}"`
      const bibTool = useBiblatex ? 'biber' : 'bibtex'
      // Remove stale .bbl — if we're here, citations are broken anyway.
      // Prevents format-switch corruption (biblatex↔bibtex cached .bbl).
      if (existsSync(bblPath)) unlinkSync(bblPath)
      addLog(`Running ${bibTool} for citations...`)
      signalBuildProgress(name, 'compiling', bibTool)
      let bibFailed = false
      try {
        await run(bibCmd, { cwd: buildDir, timeout: 60000, env: biberEnv })
        addLog(`${bibTool} done — recompiling`)
      } catch (e) {
        const errMsg = e.message || ''
        addLog(`${bibTool} failed: ${errMsg.split('\n')[0]}`)
        bibFailed = true

        // Detect biber corruption — clean state files + PAR cache and retry
        if (useBiblatex) {
          // Biber fails silently with exit code 2 when its PAR cache is corrupt
          // (Unicode::UCD error). Also fails with XML/malformed errors on bad .bcf.
          const isCorrupt = true // Always retry on biber failure — cleaning is safe
          if (isCorrupt) {
            addLog('Biber failed — clearing PAR cache and retrying')
            // Clear stale biber outputs. Keep the .bcf: it's pdflatex's control
            // file (biber's required input, regenerated every compile) — deleting
            // it would make the retry fail with "cannot find control file".
            for (const ext of ['.bbl', '.blg', '.run.xml']) {
              const f = join(buildDir, `${texBase}${ext}`)
              if (existsSync(f)) { try { unlinkSync(f) } catch {} }
              const cacheF = join(projDir, 'build-cache', `${texBase}${ext}`)
              if (existsSync(cacheF)) { try { unlinkSync(cacheF) } catch {} }
            }
            clearBiberParCache(parCacheDir, addLog)
            // Retry biber
            try {
              await run(bibCmd, { cwd: buildDir, timeout: 60000, env: biberEnv })
              addLog('Biber retry succeeded')
              bibFailed = false
            } catch (e2) {
              addLog(`Biber retry also failed: ${e2.message?.split('\n')[0]}`)
            }
          }
        }
      }
      // Recompile with bibliography — pdflatex may exit non-zero on warnings, that's fine
      try {
        await run(cmd, { cwd: texDir, timeout: 120000, env })
      } catch (e) {
        addLog(`pdflatex exited with warnings after ${bibTool} (continuing): ${e.message.split('\n')[0]}`)
      }
      // If biber still failed, check the output for raw cite keys and warn
      if (bibFailed) {
        addLog('⚠ Citations may show as raw keys — biber could not process the bibliography')
      }
    }
  }

  // Check if a second pass is needed (unresolved references)
  if (existsSync(logPath)) {
    const logText = readFileSync(logPath, 'utf8')
    if (logText.includes('Label(s) may have changed') || logText.includes('Rerun to get')) {
      addLog('References changed — running second pass')
      try {
        await run(cmd, { cwd: texDir, timeout: 120000, env })
      } catch {}
    }

    // After second pass, re-read log. If MANY citations are undefined (>5),
    // it's likely biber corruption, not just a few missing keys.
    // Run one more pass first, then nuclear clean only on mass failure.
    const postSecondLog = readFileSync(logPath, 'utf8')
    const undefinedCites = (postSecondLog.match(/Citation .* undefined/g) || []).length
    if (undefinedCites > 5) {
      addLog(`${undefinedCites} undefined citations — running third pass`)
      try { await run(cmd, { cwd: texDir, timeout: 120000, env }) } catch (e) { addLog(`third pass failed: ${e.message}`) }
      const finalLog = readFileSync(logPath, 'utf8')
      const stillUndefined = (finalLog.match(/Citation .* undefined/g) || []).length
      if (stillUndefined > 5 && existsSync(bcfPath)) {
        addLog(`${stillUndefined} citations still undefined — clearing PAR cache and retrying`)
        // Keep the .bcf (biber's input); clear only stale biber outputs.
        for (const ext of ['.bbl', '.blg', '.run.xml']) {
          const f = join(buildDir, `${texBase}${ext}`)
          if (existsSync(f)) { try { unlinkSync(f) } catch {} }
          const cacheF = join(projDir, 'build-cache', `${texBase}${ext}`)
          if (existsSync(cacheF)) { try { unlinkSync(cacheF) } catch {} }
        }
        clearBiberParCache(parCacheDir, addLog)
        const bibCmd2 = `biber --output-directory="${buildDir}" "${texBase}"`
        try {
          await run(bibCmd2, { cwd: buildDir, timeout: 60000, env: biberEnv })
          await run(cmd, { cwd: texDir, timeout: 120000, env })
          addLog('Citation recovery succeeded')
        } catch (e) {
          addLog(`Citation recovery failed: ${e.message?.split('\n')[0]}`)
        }
      }

      const recoveredLog = readFileSync(logPath, 'utf8')
      const unresolvedAfterRecovery = (recoveredLog.match(/Citation .* undefined/g) || []).length
      if (unresolvedAfterRecovery > 5) {
        throw new Error(`${unresolvedAfterRecovery} undefined citations after biber recovery`)
      }
    }
  }

  addLog(`pdflatex done in ${((Date.now() - compileStart) / 1000).toFixed(1)}s`)

  // Preserve the LaTeX log for error extraction (build dir gets cleaned up later)
  const latexLog = join(buildDir, `${texBase}.log`)
  if (existsSync(latexLog)) {
    cpSync(latexLog, join(projDir, 'latex.log'))
  }

  // Signal build errors (or clear previous ones) immediately after pdflatex
  const { errors: logErrors } = extractBuildErrors(name)
  if (logErrors.length > 0) {
    addLog(`Found ${logErrors.length} error(s) in log — signaling immediately`)
    signalBuildStatus(name, `Build has errors`)
  } else {
    signalBuildStatus(name, null)
  }

  const dviFile = join(buildDir, `${texBase}.dvi`)
  if (!existsSync(dviFile)) throw new Error('DVI file not created')

  // Parse expected page count from log for later verification against dvisvgm output
  // TeX wraps long lines at 79 chars — join continuations before matching.
  let expectedPages = null
  if (existsSync(logPath)) {
    const raw = readFileSync(logPath, 'utf8')
    const rawLines = raw.split('\n')
    const joined = []
    let prevRawLen = 0
    for (const line of rawLines) {
      if (joined.length > 0 && prevRawLen === 79) {
        joined[joined.length - 1] += line
      } else {
        joined.push(line)
      }
      prevRawLen = line.length
    }
    const logText = joined.join('\n')
    const m = logText.match(/Output written on .+\((\d+) pages?/)
    if (m) expectedPages = parseInt(m[1])
  }
  return { expectedPages }
}

/**
 * Phase 2: SVG conversion + incremental publish.
 * Converts DVI pages, patches image placeholders, hashes to detect changes,
 * publishes only changed pages, and signals partial/full reload.
 *
 * Returns { pageCount, newHashes }.
 */
async function convertSvgs(ctx, priorityPages, oldHashes, expectedPages) {
  const { name, srcDir, outDir, buildDir, texBase, addLog, run } = ctx
  const dviFile = join(buildDir, `${texBase}.dvi`)
  const svgDir = join(buildDir, 'svg')
  mkdirSync(svgDir, { recursive: true })

  // Priority pages: convert, patch, publish only if changed
  if (priorityPages?.length > 0) {
    const pageSpec = priorityPages.join(',')
    addLog(`Converting priority pages [${pageSpec}]...`)
    await run(
      `dvisvgm --page=${pageSpec} --font-format=woff2 --bbox=papersize --linkmark=none ` +
      `--output="${svgDir}/page-%p.svg" "${dviFile}"`,
      { cwd: srcDir },
    )
    normalizeSvgNames(svgDir)
    try {
      await run(
        `node "${join(SCRIPTS_DIR, 'patch-svg-images.mjs')}" "${svgDir}" "${srcDir}"`,
        { cwd: PROJECT_ROOT, timeout: 60000 },
      )
    } catch (e) {
      addLog(`Image patching failed (non-fatal): ${e.message.split('\n')[0]}`)
    }
    const changedPriority = []
    for (const p of priorityPages) {
      const f = `page-${p}.svg`
      const svgPath = join(svgDir, f)
      if (!existsSync(svgPath)) continue
      const hash = hashSvgContent(readFileSync(svgPath, 'utf8'))
      if (hash !== oldHashes[f]) {
        publishFile(svgPath, join(outDir, f))
        changedPriority.push(p)
      }
    }
    if (changedPriority.length > 0) {
      signalBuildProgress(name, 'hot', `${changedPriority.length === 1 ? 'page' : 'pages'} ${changedPriority.join(',')}`)
      signalReload(name, changedPriority)
      addLog(`Priority: ${changedPriority.length}/${priorityPages.length} pages changed`)
    } else {
      addLog(`Priority: 0/${priorityPages.length} pages changed, skipping reload`)
    }
  }

  // All pages
  addLog('Converting all pages...')
  const svgStart = Date.now()
  await run(
    `dvisvgm --page=1- --font-format=woff2 --bbox=papersize --linkmark=none ` +
    `--output="${svgDir}/page-%p.svg" "${dviFile}"`,
    { cwd: srcDir, timeout: 300000 },
  )
  normalizeSvgNames(svgDir)
  addLog(`SVG conversion done in ${((Date.now() - svgStart) / 1000).toFixed(1)}s`)

  const allPageFiles = readdirSync(svgDir).filter(f => /^page-\d+\.svg$/.test(f))
  const pageCount = allPageFiles.length

  if (expectedPages && pageCount < expectedPages) {
    addLog(`WARNING: dvisvgm produced ${pageCount}/${expectedPages} pages — ${expectedPages - pageCount} pages missing`)
    signalBuildProgress(name, 'converting', `${expectedPages - pageCount} pages missing`)
  }

  // Patch all image placeholders (fast, ~70ms)
  addLog('Patching image placeholders...')
  try {
    const { stdout: patchStdout } = await run(
      `node "${join(SCRIPTS_DIR, 'patch-svg-images.mjs')}" "${svgDir}" "${srcDir}"`,
      { cwd: PROJECT_ROOT, timeout: 60000 },
    )
    const patchOutput = (patchStdout || '').trim()
    if (patchOutput) addLog(patchOutput.split('\n').pop())
  } catch (e) {
    addLog(`Image patching failed (non-fatal): ${e.message.split('\n')[0]}`)
  }

  // Hash patched SVGs to detect which pages actually changed
  const newHashes = {}
  for (const f of allPageFiles) {
    newHashes[f] = hashSvgContent(readFileSync(join(svgDir, f), 'utf8'))
  }

  const changedPageFiles = allPageFiles.filter(f => newHashes[f] !== oldHashes[f])
  const changedPageNums = changedPageFiles.map(f => parseInt(f.match(/page-(\d+)\.svg/)[1]))
  const changedSet = new Set(changedPageNums)

  addLog(`${changedPageFiles.length}/${pageCount} pages changed`)

  // Publish only changed page SVGs
  for (const f of allPageFiles) {
    const pageNum = parseInt(f.match(/page-(\d+)\.svg/)[1])
    if (changedSet.has(pageNum)) {
      publishFile(join(svgDir, f), join(outDir, f))
    }
  }
  if (changedPageFiles.length < pageCount) {
    addLog(`Published ${changedPageFiles.length}/${pageCount} pages`)
  }

  // Remove stale pages beyond new page count
  for (const f of readdirSync(outDir)) {
    const m = f.match(/^page-(\d+)\.svg$/)
    if (m && parseInt(m[1]) > pageCount) unlinkSync(join(outDir, f))
  }

  // Signal reload — partial if only some pages changed
  if (changedPageFiles.length > 0 && changedPageFiles.length < allPageFiles.length) {
    signalReload(name, changedPageNums)
  } else {
    signalReload(name, null)
  }

  return { pageCount, newHashes, changedPages: changedPageNums }
}

/** Phase 3: Extract macros from preamble. */
async function extractMacros(ctx) {
  const { texPath, buildDir, outDir, texBase, addLog, run } = ctx
  addLog('Extracting preamble macros...')
  try {
    await run(
      `node "${join(SCRIPTS_DIR, 'extract-preamble.js')}" "${texPath}" "${join(buildDir, 'macros.json')}"`,
      { cwd: PROJECT_ROOT },
    )
    publishFile(join(buildDir, 'macros.json'), join(outDir, `${texBase}-macros.json`))
  } catch (e) {
    addLog(`Macro extraction failed (non-fatal): ${e.message}`)
  }
}

/** Phase 4: Extract synctex lookup. Returns true if successful. */
async function extractSynctex(ctx) {
  const { texBase, mainFile, srcDir, buildDir, outDir, addLog, run } = ctx
  const synctexFile = join(buildDir, `${texBase}.synctex.gz`)
  if (!existsSync(synctexFile)) {
    addLog('No synctex.gz found, skipping lookup + proof pairing')
    return false
  }

  // The extractor derives synctex.gz location from the .tex path's directory.
  // Copy synctex.gz next to the source .tex so the script finds both.
  // mainFile may have a subdir prefix (e.g. "revision/foo.tex"), so use dirname(mainFile).
  cpSync(synctexFile, join(srcDir, dirname(mainFile), `${texBase}.synctex.gz`))

  addLog('Extracting synctex lookup...')
  const synctexStart = Date.now()
  try {
    await run(
      `node "${join(SCRIPTS_DIR, 'extract-synctex-lookup.mjs')}" "${join(srcDir, mainFile)}" "${join(buildDir, 'lookup.json')}"`,
      { cwd: PROJECT_ROOT, timeout: 600000 },
    )
    publishFile(join(buildDir, 'lookup.json'), join(outDir, `${texBase}-lookup.json`))
    // Also publish the synctex.gz so ensure recipes find <texBase>.synctex.gz alongside the dvi.
    publishFile(synctexFile, join(outDir, `${texBase}.synctex.gz`))
    addLog(`Synctex done in ${((Date.now() - synctexStart) / 1000).toFixed(1)}s`)
    return true
  } catch (e) {
    addLog(`Synctex extraction failed (non-fatal): ${e.message}`)
    return false
  }
}

/** Phase 5: Compute proof pairing (depends on lookup.json). */
async function computeProofPairing(ctx) {
  const { texPath, buildDir, outDir, texBase, addLog, run } = ctx
  addLog('Computing proof pairing...')
  try {
    await run(
      `node "${join(SCRIPTS_DIR, 'compute-proof-pairing.mjs')}" "${texPath}" ` +
      `"${join(buildDir, 'lookup.json')}" "${join(buildDir, 'proof-info.json')}" ` +
      `"${join(buildDir, `${texBase}.aux`)}"`,
      { cwd: PROJECT_ROOT, timeout: 120000 },
    )
    publishFile(join(buildDir, 'proof-info.json'), join(outDir, `${texBase}-proof-info.json`))
  } catch (e) {
    addLog(`Proof pairing failed (non-fatal): ${e.message}`)
  }
}

/** Phase 7: Generate source-map.json — unified client index.
 * Combines synctex positions + label data into one file:
 * - labels: all \label{} items with page, position, type, number
 * - pages: per-page line index (y → file:line) for forward/reverse lookup
 */
async function generateSourceMap(ctx) {
  const { name, texBase, buildDir, outDir, srcDir, addLog } = ctx
  const { loadSynctex } = await import('./synctex-query.mjs')

  try {
    const synctex = await loadSynctex(name, texBase)
    if (!synctex) { addLog('Source map: no synctex data'); return }

    // Build per-page line index: sorted list of { y, file, line }
    // Deduplicate by file:line (keep the first y for each source location).
    // Hoist realpathSync out of the loop — was being called per-record (350+ records on
    // bregman), blocking the event loop ~750ms. Now resolved once per build.
    let realSrcDir = null
    try { realSrcDir = realpathSync(sourceDir(name)) } catch {}
    const pageIndex = {}
    const seen = new Set()
    for (const r of synctex.records) {
      const filePath = synctex.inputMap.get(r.inputId)
      if (!filePath || !filePath.endsWith('.tex')) continue
      // Derive relative file name
      let relFile = filePath
      if (realSrcDir && filePath.startsWith(realSrcDir)) {
        relFile = filePath.slice(realSrcDir.length + 1)
      }
      const key = `${r.page}:${relFile}:${r.line}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!pageIndex[r.page]) pageIndex[r.page] = []
      pageIndex[r.page].push({ y: Math.round(r.y * 10) / 10, file: relFile, line: r.line })
    }
    // Sort each page's entries by y
    for (const page of Object.keys(pageIndex)) {
      pageIndex[page].sort((a, b) => a.y - b.y)
    }

    // Parse labels directly from .aux file
    const auxFile = join(buildDir, `${texBase}.aux`)
    let labels = []
    if (existsSync(auxFile)) {
      const auxText = readFileSync(auxFile, 'utf8')
      const re = /\\newlabel\{([^}@]+)\}\{\{([^}]*)\}\{([^}]*)\}\{([^}]*)\}/g
      let m
      while ((m = re.exec(auxText)) !== null) {
        const [, label, number, page, title] = m
        const pageNum = parseInt(page, 10)
        if (isNaN(pageNum)) continue
        const type = label.includes(':') ? label.split(':')[0] : 'label'
        labels.push({ label, type, number: number.trim(), page: pageNum, title: title.trim() })
      }
    }

    const sourceMap = { labels, pages: pageIndex }
    const outPath = join(outDir, `${texBase}-source-map.json`)
    writeFileSync(outPath, JSON.stringify(sourceMap))
    const sizeKB = Math.round(statSync(outPath).size / 1024)
    addLog(`Source map: ${labels.length} labels, ${Object.keys(pageIndex).length} pages (${sizeKB} KB)`)
  } catch (e) {
    addLog(`Source map generation failed: ${e.message}`)
  }
}

/** Summarize a git diff into a structural change outline.
 *  Groups changes by section/subsection and identifies formal results (theorems, lemmas, etc.)
 *  and their proofs. Returns a markdown-formatted summary or null if no meaningful changes.
 */
function summarizeDiff(diffText, projectName) {
  const projDir = projectDir(projectName)
  const outDir = outputDir(projectName)

  // 1. Parse diff hunks: extract file, old/new line ranges, and +/- counts
  const hunks = parseDiffHunks(diffText)
  if (hunks.length === 0) return null

  // 2. Build section tree from tex source in shadow repo
  const shadowDir = join(projDir, 'shadow-repo')
  const project = readProject(projectName)
  const mainFile = project?.mainFile || ''
  const texPath = join(shadowDir, mainFile)
  let texLines = []
  try { texLines = readFileSync(texPath, 'utf8').split('\n') } catch { return null }
  const sections = buildSectionTree(texLines)

  // Diff summary is keyed off the primary target's metadata.
  const primaryTexBase = basename(mainFile, '.tex')

  // 3. Load <primary>-proof-info.json for result/proof line ranges
  let proofPairs = []
  try {
    const pi = JSON.parse(readFileSync(join(outDir, `${primaryTexBase}-proof-info.json`), 'utf8'))
    proofPairs = pi.pairs || pi
  } catch (e) { console.warn(`[build] proof-info.json parse failed for ${name}: ${e.message}`) }

  // 4. Load <primary>-source-map.json labels for numbering
  const labelNumbers = new Map()
  try {
    const sm = JSON.parse(readFileSync(join(outDir, `${primaryTexBase}-source-map.json`), 'utf8'))
    for (const l of sm.labels || []) {
      labelNumbers.set(l.label, l.number)
    }
  } catch (e) { console.warn(`[build] source-map.json parse failed for ${name}: ${e.message}`) }

  // 5. Parse result titles from tex source (the [...] optional argument)
  const resultTitles = new Map()
  for (const pair of proofPairs) {
    const startLine = pair.statementLines?.[0]
    if (startLine && startLine <= texLines.length) {
      const line = texLines[startLine - 1]
      const titleMatch = line.match(/\\begin\{(?:theorem|lemma|proposition|corollary|definition)\}\[([^\]]*)\]/)
      if (titleMatch) {
        // Strip \cite/\citep/\citet commands to get clean title
        let title = titleMatch[1].replace(/\\(?:cite[pt]?)\{[^}]*\}/g, '').replace(/[{}]/g, '').trim()
        // Check if it's a borrowed result (had a citation)
        const isBorrowed = /\\(?:cite[pt]?)\{/.test(titleMatch[1])
        resultTitles.set(pair.id, { title, isBorrowed })
      }
    }
  }

  // 6. Classify each hunk
  const changes = []
  for (const hunk of hunks) {
    // Find containing section/subsection
    const section = findContainingSection(sections, hunk.newStart)

    // Check if hunk overlaps any formal result statement or proof
    let resultHit = null
    for (const pair of proofPairs) {
      const [stmtStart, stmtEnd] = pair.statementLines || [0, 0]
      const [proofStart, proofEnd] = pair.proofLines || [0, 0]

      if (hunkOverlaps(hunk, stmtStart, stmtEnd)) {
        const num = labelNumbers.get(pair.id) || ''
        const titleInfo = resultTitles.get(pair.id)
        const typeName = pair.type.charAt(0).toUpperCase() + pair.type.slice(1)
        resultHit = { type: 'statement', resultType: typeName, id: pair.id, number: num, title: titleInfo?.title || '' }
        break
      }
      if (hunkOverlaps(hunk, proofStart, proofEnd)) {
        const num = labelNumbers.get(pair.id) || ''
        const titleInfo = resultTitles.get(pair.id)
        const typeName = pair.type.charAt(0).toUpperCase() + pair.type.slice(1)
        resultHit = { type: 'proof', resultType: typeName, id: pair.id, number: num, title: titleInfo?.title || '' }
        break
      }
    }

    changes.push({ section, result: resultHit, added: hunk.added, deleted: hunk.deleted, file: hunk.file })
  }

  // 7. Aggregate by section, then by result
  return formatChangeSummary(changes, labelNumbers)
}

function parseDiffHunks(diffText) {
  const hunks = []
  let currentFile = null
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git')) {
      const m = line.match(/^diff --git a\/(.+?) b\//)
      if (m) currentFile = m[1]
      continue
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunkMatch) {
      hunks.push({
        file: currentFile,
        oldStart: parseInt(hunkMatch[1]),
        oldCount: parseInt(hunkMatch[2] || '1'),
        newStart: parseInt(hunkMatch[3]),
        newCount: parseInt(hunkMatch[4] || '1'),
        added: 0,
        deleted: 0,
      })
      continue
    }
    if (hunks.length > 0) {
      if (line.startsWith('+') && !line.startsWith('+++')) hunks[hunks.length - 1].added++
      if (line.startsWith('-') && !line.startsWith('---')) hunks[hunks.length - 1].deleted++
    }
  }
  return hunks
}

function buildSectionTree(texLines) {
  const sections = []
  for (let i = 0; i < texLines.length; i++) {
    const m = texLines[i].match(/\\(section|subsection|subsubsection)\{(.+?)\}/)
    if (m) {
      const title = m[2].replace(/\\[a-zA-Z]+\{[^}]*\}/g, '').replace(/[{}\\]/g, '').trim()
      // Check next few lines for \label{sec:...} (may not be immediately after)
      let label = null
      for (let k = 1; k <= 3 && i + k < texLines.length; k++) {
        const labelMatch = texLines[i + k].match(/\\label\{(sec:[^}]+)\}/)
        if (labelMatch) { label = labelMatch[1]; break }
        // Stop if we hit another sectioning command or begin/end
        if (texLines[i + k].match(/\\(?:section|subsection|begin|end)\{/)) break
      }
      sections.push({ level: m[1], title, line: i + 1, label })
    }
  }
  // Assign end lines (each section ends where the next same-or-higher level section begins)
  for (let i = 0; i < sections.length; i++) {
    const levelRank = { section: 0, subsection: 1, subsubsection: 2 }
    const myRank = levelRank[sections[i].level] ?? 0
    let endLine = texLines.length
    for (let j = i + 1; j < sections.length; j++) {
      const nextRank = levelRank[sections[j].level] ?? 0
      if (nextRank <= myRank) { endLine = sections[j].line - 1; break }
    }
    sections[i].endLine = endLine
  }
  return sections
}

function findContainingSection(sections, line) {
  // Find the deepest (most specific) section containing this line
  let best = null
  for (const s of sections) {
    if (line >= s.line && line <= s.endLine) {
      if (!best || ({ section: 0, subsection: 1, subsubsection: 2 }[s.level] ?? 0) > ({ section: 0, subsection: 1, subsubsection: 2 }[best.level] ?? 0)) {
        best = s
      }
    }
  }
  return best
}

function hunkOverlaps(hunk, startLine, endLine) {
  if (!startLine || !endLine) return false
  const hunkEnd = hunk.newStart + hunk.newCount - 1
  return hunk.newStart <= endLine && hunkEnd >= startLine
}

function formatChangeSummary(changes, labelNumbers) {
  // Group by section title, then by result
  const groups = new Map()
  for (const c of changes) {
    const secKey = c.section ? (c.section.label || c.section.title) : '(preamble)'
    if (!groups.has(secKey)) groups.set(secKey, { section: c.section, items: [] })
    groups.get(secKey).items.push(c)
  }

  const lines = []
  for (const [secKey, group] of groups) {
    let sectionLabel
    if (!group.section) {
      sectionLabel = '**Preamble**'
    } else {
      const num = group.section.label ? labelNumbers?.get(group.section.label) : null
      const prefix = num ? `§${num}` : '§'
      sectionLabel = `**${prefix} "${group.section.title}"**`
    }
    lines.push(sectionLabel)

    // Sub-group by result
    const resultItems = new Map()
    const textItems = []
    for (const item of group.items) {
      if (item.result) {
        const rKey = `${item.result.id}:${item.result.type}`
        if (!resultItems.has(rKey)) resultItems.set(rKey, { result: item.result, added: 0, deleted: 0 })
        const r = resultItems.get(rKey)
        r.added += item.added
        r.deleted += item.deleted
      } else {
        textItems.push(item)
      }
    }

    for (const [, r] of resultItems) {
      const { result, added, deleted } = r
      const numStr = result.number ? ` ${result.number}` : ''
      const titleStr = result.title ? ` (${result.title})` : ''
      const locStr = result.type === 'proof' ? 'proof' : 'statement'
      const countStr = formatCounts(added, deleted)
      lines.push(`  - ${result.resultType}${numStr}${titleStr} ${locStr}: ${countStr}`)
    }

    if (textItems.length > 0) {
      const totalAdded = textItems.reduce((s, i) => s + i.added, 0)
      const totalDeleted = textItems.reduce((s, i) => s + i.deleted, 0)
      lines.push(`  - text: ${formatCounts(totalAdded, totalDeleted)}`)
    }
  }

  return lines.length > 0 ? lines.join('\n') : null
}

function formatCounts(added, deleted) {
  const parts = []
  if (added > 0) parts.push(`+${added}`)
  if (deleted > 0) parts.push(`-${deleted}`)
  return parts.join(' / ') || 'modified'
}

/** Phase 6: Generate theorem-map.json from .aux file. */
async function generateTheoremMap(ctx) {
  const { texBase, texDir, srcDir, buildDir, outDir, addLog } = ctx
  const auxFile = join(buildDir, `${texBase}.aux`)
  if (!existsSync(auxFile)) {
    addLog('No .aux file, skipping theorem map')
    return
  }

  const auxText = readFileSync(auxFile, 'utf8')

  // Parse \newlabel{LABEL}{{NUMBER}{PAGE}{TITLE}{...}} — skip @cref variants
  // Include ALL labels (theorems, equations, sections, figures, etc.)
  const re = /\\newlabel\{([^}@]+)\}\{\{([^}]*)\}\{([^}]*)\}\{([^}]*)\}/g
  const entries = []
  let m
  while ((m = re.exec(auxText)) !== null) {
    const [, label, number, page, title] = m
    const pageNum = parseInt(page, 10)
    if (isNaN(pageNum)) continue
    const type = label.includes(':') ? label.split(':')[0] : 'label'
    entries.push({ label, type, number: number.trim(), page: pageNum, title: title.trim() })
  }

  if (entries.length === 0) {
    addLog('Theorem map: no entries found')
    return
  }

  // Find source line by searching .tex files in texDir (non-recursive)
  const texFilesInDir = (dir) => {
    try { return readdirSync(dir).filter(f => f.endsWith('.tex')).map(f => join(dir, f)) }
    catch { return [] }
  }
  const texFiles = [...new Set([...texFilesInDir(texDir), ...(texDir !== srcDir ? texFilesInDir(srcDir) : [])])]

  for (const entry of entries) {
    const pattern = `\\label{${entry.label}}`
    for (const texFile of texFiles) {
      try {
        const lines = readFileSync(texFile, 'utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(pattern)) {
            entry.file = basename(texFile)
            entry.line = i + 1
            break
          }
        }
        if (entry.line != null) break
      } catch {}
    }
  }

  const map = {}
  for (const entry of entries) map[entry.label] = entry

  const tmpPath = join(buildDir, 'theorem-map.json')
  writeFileSync(tmpPath, JSON.stringify(map, null, 2))
  publishFile(tmpPath, join(outDir, `${texBase}-theorem-map.json`))

  addLog(`Theorem map: ${entries.length} entries`)
}

/** Cache build state (.aux, .bbl, etc.) for next incremental build. */
function saveBuildCache(ctx) {
  const { buildDir, projDir, addLog } = ctx
  const cacheDir = join(projDir, 'build-cache')
  const CACHE_EXTS = /\.(aux|bbl|toc|out|synctex\.gz|fmt)$/
  try {
    mkdirSync(cacheDir, { recursive: true })
    for (const f of readdirSync(buildDir)) {
      if (CACHE_EXTS.test(f)) cpSync(join(buildDir, f), join(cacheDir, f))
    }
  } catch (e) {
    addLog(`Cache save failed (non-fatal): ${e.message}`)
  }
}

// Parse the .fls file pdflatex -recorder produced and write a
// relevant-files.json listing every INPUT path that lives inside the
// project's sourceDir (the authoring directory, not the per-project
// mirror under server/projects). The server uses this set to filter
// source-change pushes from the daemon — changes to files outside the
// set don't trigger rebuilds.
function writeRelevantFiles(ctx) {
  const { name, buildDir, texBase, srcDir, outDir, project, addLog } = ctx
  const flsPath = join(buildDir, `${texBase}.fls`)
  if (!existsSync(flsPath)) {
    addLog(`Relevant files: .fls not found at ${flsPath} (skipping)`)
    return
  }
  // The authoring source dir lives at project.sourceDir (daemon-watched).
  // srcDir is the per-project mirror under server/projects/<name>/source/;
  // pdflatex compiled from srcDir, so INPUT lines reference srcDir paths.
  // We translate them to authoring-dir paths so the set matches what the
  // daemon actually pushes from.
  const authorDir = project?.sourceDir
  // Resolve the source/author dirs once. On Fly, /app/server/projects is a
  // symlink to /app/server/persist/projects (fly-entrypoint-live.sh), so
  // realpathSync(<input>) yields the persist path. We must compare against the
  // RESOLVED dirs, but emit paths in the LITERAL srcDir/authorDir space the rest
  // of the pipeline (readPaperScope, the daemon watch filter) expects. See
  // relevantPathsForInput. Before this, the post-realpath input was tested
  // against the un-resolved srcDir, never matched, and the paper scope came out
  // empty — which silently froze shadow commits after the 2026-06-14 persist
  // migration (commit 46fb299d introduced the symlink).
  const dirs = { srcDir, authorDir, realSrcDir: realDirOf(srcDir), realAuthorDir: realDirOf(authorDir) }
  const relevant = new Set()
  let lineCount = 0
  try {
    const fls = readFileSync(flsPath, 'utf8')
    for (const line of fls.split('\n')) {
      if (!line.startsWith('INPUT ')) continue
      lineCount++
      const raw = line.slice(6).trim()
      if (!raw) continue
      for (const rp of relevantPathsForInput(raw, dirs)) relevant.add(rp)
    }
  } catch (e) {
    addLog(`Relevant files: parse failed (non-fatal): ${e.message}`)
    return
  }
  // Augment with bibtex inputs (.bib, .bst) — pdflatex doesn't read these
  // but bibtex does. Parse \bibdata and \bibstyle from the .aux file.
  const auxPath = join(buildDir, `${texBase}.aux`)
  if (existsSync(auxPath)) {
    try {
      const aux = readFileSync(auxPath, 'utf8')
      const bibdataMatch = aux.match(/\\bibdata\{([^}]+)\}/)
      if (bibdataMatch) {
        for (const stem of bibdataMatch[1].split(',')) {
          addRelevantPath(relevant, stem.trim() + '.bib', srcDir, authorDir)
        }
      }
      const bibstyleMatch = aux.match(/\\bibstyle\{([^}]+)\}/)
      if (bibstyleMatch) {
        addRelevantPath(relevant, bibstyleMatch[1].trim() + '.bst', srcDir, authorDir)
      }
    } catch {}
  }
  // Augment with SVG siblings of included PDF figures — tlda's patch pipeline
  // renders SVGs, not the PDFs that pdflatex reads.
  for (const p of [...relevant]) {
    if (!p.endsWith('.pdf')) continue
    const svgPath = p.replace(/\.pdf$/, '.svg')
    if (existsSync(svgPath)) relevant.add(svgPath)
  }
  // Augment with markdown source files for generated scratch .tex files.
  // The build runner converts .tlda/scratch/*.md → .tex; pdflatex only
  // sees the .tex, but the daemon needs to watch the .md source.
  for (const p of [...relevant]) {
    if (!p.includes('.tlda/scratch/') || !p.endsWith('.tex')) continue
    const mdPath = p.replace(/\.tex$/, '.md')
    if (existsSync(mdPath)) relevant.add(mdPath)
  }
  // Augment with xr / xr-hyper externally-referenced documents. When main
  // does \externaldocument{X}, xr writes \@input{X.aux} into main's .aux —
  // that's the marker. Treat X as a paper file: include X.tex + (if
  // present) the inputs reachable from X via its own .fls.
  if (existsSync(auxPath)) {
    try {
      const aux = readFileSync(auxPath, 'utf8')
      for (const m of aux.matchAll(/\\@input\{([^}]+)\.aux\}/g)) {
        const stem = m[1]
        addRelevantPath(relevant, stem + '.tex', srcDir, authorDir)
        // If pdflatex has been run on the xr target separately, its .fls is
        // available — pull its INPUT lines into the paper scope too.
        const xrFls = join(srcDir, stem + '.fls')
        if (existsSync(xrFls)) {
          try {
            for (const line of readFileSync(xrFls, 'utf8').split('\n')) {
              if (!line.startsWith('INPUT ')) continue
              const raw = line.slice(6).trim()
              if (!raw) continue
              for (const rp of relevantPathsForInput(raw, dirs)) relevant.add(rp)
            }
          } catch {}
        }
      }
    } catch {}
  }
  const outPath = join(outDir, `${texBase}-relevant-files.json`)
  try {
    writeFileSync(outPath, JSON.stringify({
      generated_at: new Date().toISOString(),
      source_dir: authorDir || srcDir,
      files: [...relevant].sort(),
    }, null, 2))
    addLog(`Relevant files: ${relevant.size} entries from ${lineCount} INPUT lines`)
  } catch (e) {
    addLog(`Relevant files: write failed (non-fatal): ${e.message}`)
  }
}

/** Add a relative path to the relevant set, resolving against srcDir and authorDir.
 * Stores the LITERAL srcDir/authorDir paths (not realpathSync'd) — downstream
 * consumers (readPaperScope, the daemon watch filter) work in literal space, and
 * existsSync already follows the symlink so the existence check is correct. */
function addRelevantPath(relevant, relPath, srcDir, authorDir) {
  const mirrorPath = join(srcDir, relPath)
  if (existsSync(mirrorPath)) relevant.add(mirrorPath)
  if (authorDir) {
    const authorPath = join(authorDir, relPath)
    if (existsSync(authorPath)) relevant.add(authorPath)
  }
}

/** realpathSync(dir), or the dir itself if it can't be resolved (e.g. doesn't
 * exist yet). Used to make symlinked source dirs (Fly's persist volume) compare
 * correctly without changing the literal paths we store. */
function realDirOf(dir) {
  if (!dir) return dir
  try { return realpathSync(dir) } catch { return dir }
}

/**
 * Map one .fls INPUT path to the relevant-file paths it contributes (possibly
 * empty). System/texlive paths and anything outside the project's source/author
 * dirs return []. Symlink-safe: the input is realpath-resolved (so it may land
 * under Fly's persist volume), compared against the RESOLVED source/author dirs,
 * but emitted in the LITERAL srcDir/authorDir space that readPaperScope and the
 * daemon watch filter expect — never the resolved/persist path.
 *
 * `dirs` = { srcDir, authorDir, realSrcDir, realAuthorDir }. Exported for tests.
 */
export function relevantPathsForInput(raw, { srcDir, authorDir, realSrcDir, realAuthorDir }) {
  let p = raw
  if (!p) return []
  // Absolute texlive / system paths: skip unless under the source/author dir
  // (test both literal and resolved forms — the symlink makes them differ).
  if (p.startsWith('/') &&
      !p.startsWith(srcDir) && !p.startsWith(realSrcDir) &&
      !(authorDir && (p.startsWith(authorDir) || (realAuthorDir && p.startsWith(realAuthorDir))))) {
    return []
  }
  // Relative paths: resolve against srcDir (pdflatex's source base).
  if (!p.startsWith('/')) p = join(srcDir, p)
  // Resolve symlinks / collapse .. so the prefix test is apples-to-apples.
  try { p = realpathSync(p) } catch { /* file may not exist anymore */ }
  const out = []
  if (p.startsWith(realSrcDir + '/')) {
    const rel = p.slice(realSrcDir.length + 1)
    if (authorDir) out.push(join(authorDir, rel))
    out.push(join(srcDir, rel)) // literal mirror path (what readPaperScope expects)
  } else if (realAuthorDir && p.startsWith(realAuthorDir + '/')) {
    const rel = p.slice(realAuthorDir.length + 1)
    out.push(join(authorDir, rel))
  }
  return out
}

// Detect xr-referenced sibling .tex files in the project's primary main.
// Scans main's .tex source (top-level only; doesn't follow \input chains —
// most papers put \externaldocument near \usepackage{xr}, not nested).
// Returns relative .tex filenames that exist next to main.
//
// Used when project.json doesn't explicitly declare mainFiles[], so the
// user can flip arxiv-mode by editing source — toggling \arxivtrue (which
// controls whether xr loads) implicitly adds/removes secondary targets.
function detectXrSiblings(srcDir, mainFile) {
  const mainPath = join(srcDir, mainFile)
  if (!existsSync(mainPath)) return []
  let source
  try { source = readFileSync(mainPath, 'utf8') } catch { return [] }
  // Strip comments so commented-out \externaldocument lines don't trigger.
  // (Inline % comments only — not full-line escape handling.)
  const stripped = source.replace(/(^|[^\\])%[^\n]*/g, '$1')
  const out = []
  for (const m of stripped.matchAll(/\\externaldocument(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    const stem = m[1].trim()
    const rel = stem.endsWith('.tex') ? stem : stem + '.tex'
    if (rel === mainFile) continue
    if (existsSync(join(srcDir, rel))) out.push(rel)
  }
  return out
}

// Topologically sort mainFiles so xr-dependents come AFTER their targets.
// "Dependent": main with \externaldocument{X} reads X.aux at compile time, so
// X must be built first. We scan main's .tex source (and inputs reachable
// from it) for \externaldocument{...} references. Any referenced X that's
// also a mainFile in the project gets ordered before main. Falls back to
// the declared order on parse failure or unresolvable cycles.
function orderTargetsByXrDeps(mainFiles, srcDir) {
  if (mainFiles.length <= 1) return { ordered: [...mainFiles], hasCycle: false, hasXrDeps: false }
  const stems = new Set(mainFiles.map(f => basename(f, '.tex')))
  // Map texBase → set of texBases it depends on (xr-references).
  const deps = new Map()
  let hasXrDeps = false
  for (const mf of mainFiles) {
    const stem = basename(mf, '.tex')
    deps.set(stem, new Set())
    const path = join(srcDir, mf)
    if (!existsSync(path)) continue
    let source
    try { source = readFileSync(path, 'utf8') } catch { continue }
    // Match \externaldocument[prefix]{X} — prefix optional.
    for (const m of source.matchAll(/\\externaldocument(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
      const target = m[1].trim()
      if (stems.has(target)) {
        deps.get(stem).add(target)
        hasXrDeps = true
      }
    }
  }
  // Topo sort: emit nodes whose deps are all already emitted.
  const remaining = new Set(mainFiles.map(f => basename(f, '.tex')))
  const ordered = []
  let hasCycle = false
  while (remaining.size > 0) {
    let progress = false
    for (const stem of remaining) {
      const ds = deps.get(stem) || new Set()
      const unmet = [...ds].some(d => remaining.has(d))
      if (!unmet) {
        ordered.push(stem)
        remaining.delete(stem)
        progress = true
        break
      }
    }
    if (!progress) {
      // Cycle — fall back to declared order for the rest.
      hasCycle = true
      for (const stem of remaining) ordered.push(stem)
      break
    }
  }
  // Map back to mainFile names in the resolved order.
  const byStem = new Map(mainFiles.map(f => [basename(f, '.tex'), f]))
  const orderedFiles = ordered.map(s => byStem.get(s)).filter(Boolean)
  return { ordered: orderedFiles, hasCycle, hasXrDeps }
}

// If the project's working copy is a git repo and the shadow is still
// empty (or has only the initial init commit), seed the shadow by filtering
// the working-copy git history to paper-scope. Skip if the shadow already
// has real commits — bootstrap runs once, then commitSnapshot takes over.
async function maybeBootstrapShadowFromProjectRepo(name) {
  const project = readProject(name)
  if (!project?.sourceDir) return
  const sourceDir = project.sourceDir
  if (!existsSync(join(sourceDir, '.git'))) return

  const shadowDir = join(projectDir(name), 'shadow-repo')
  // Already has real history? Skip (defined as: at least 2 commits, since the
  // blank initShadowRepo seeds an "init" commit with .gitignore).
  if (existsSync(join(shadowDir, '.git'))) {
    try {
      const { stdout: cntOut } = await _execAsync('git rev-list --count HEAD 2>/dev/null', {
        cwd: shadowDir, timeout: 5000,
      })
      const cnt = cntOut.trim()
      if (parseInt(cnt, 10) > 1) return
    } catch { /* missing HEAD or empty repo — proceed with bootstrap */ }
  }

  // Need a paper-scope to filter — written by writeRelevantFiles just above.
  const relPath = join(outputDir(name), 'relevant-files.json')
  if (!existsSync(relPath)) return
  let parsed
  try { parsed = JSON.parse(readFileSync(relPath, 'utf8')) } catch (e) { console.warn(`[build] corrupt relevant-files.json for ${name}: ${e.message}`); return }
  const files = Array.isArray(parsed?.files) ? parsed.files : []
  const scope = files
    .filter(p => typeof p === 'string' && p.startsWith(sourceDir + '/'))
    .map(p => p.slice(sourceDir.length + 1))
  if (scope.length === 0) return

  // Move existing blank shadow out of the way so initShadowFromProjectRepo
  // can clone fresh. The blank shadow is just an init commit + .gitignore;
  // safe to discard.
  if (existsSync(shadowDir)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    renameSync(shadowDir, shadowDir + '-pre-init-' + ts)
  }
  await initShadowFromProjectRepo(name, sourceDir, scope)
  // The re-init created a new git history. Clean up stale shadow/* tags from the
  // working copy — they pointed at the old history and would cause `git fetch --tags`
  // to fail on the next build (git refuses to overwrite tags without --force).
  try {
    const { stdout: staleOut } = await _execAsync(`git tag -l "shadow/*"`, { cwd: sourceDir, timeout: 5000 })
    const stale = staleOut.trim()
    if (stale) {
      const tagList = stale.split('\n').filter(Boolean)
      await _execAsync(`git tag -d ${tagList.map(t => `"${t}"`).join(' ')}`, { cwd: sourceDir, timeout: 5000 })
      console.log(`[build:${name}] cleared ${tagList.length} stale shadow/* tags from working copy after bootstrap`)
    }
  } catch (e) {
    console.warn(`[build:${name}] failed to clear stale shadow tags: ${e.message}`)
  }
}

// ─── Exported helpers ────────────────────────────────────────────────────────

export function emitDocArrived(name) {
  try {
    const updated = readProject(name)
    if (updated?.buildStatus === 'success') {
      _reporter.emitGlobalEvent('doc-arrived', {
        name, title: updated.title || name,
        format: updated.format, pages: updated.pages || 0,
      })
    }
  } catch {}
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export async function runBuild(name, { priorityPages: explicitPriority } = {}) {
  // Serialize builds per project: wait for any in-flight build to finish before starting.
  while (_buildLocks.has(name)) {
    // Kill the running build so we don't wait for it to complete naturally.
    const existing = activeBuilds.get(name)
    if (existing?.building) {
      console.log(`[build:${name}] Killing in-progress build, restarting`)
      killBuildProcesses(existing.buildId)
      existing.building = false
      existing.phase = 'cancelled'
    }
    await _buildLocks.get(name).catch(e => console.warn(`[build:${name}] previous build lock error:`, e.message))
  }
  let releaseLock
  _buildLocks.set(name, new Promise(r => { releaseLock = r }))

  try { return await _runBuildInner(name, { priorityPages: explicitPriority }) }
  finally { _buildLocks.delete(name); releaseLock() }
}

async function _runBuildInner(name, { priorityPages: explicitPriority } = {}) {
  let priorityPages = explicitPriority
  if (!priorityPages) {
    try {
      const { getLastSignal } = await import('./sync-rooms.mjs')
      const viewport = getLastSignal(`doc-${name}`, 'signal:viewport')
      if (viewport?.pages?.length > 0) {
        priorityPages = viewport.pages
      }
    } catch {}
  }
  if (!priorityPages || priorityPages.length === 0) {
    priorityPages = [1]
  }

  // Increment version so any in-flight mirror callbacks from previous builds
  // can detect they've been superseded and skip.
  const myVersion = (buildVersion.get(name) || 0) + 1
  buildVersion.set(name, myVersion)

  // Set buildStatus early — before any validation that might throw.
  try { _reporter.updateProject(name, { buildStatus: 'building', lastBuild: new Date().toISOString() }) } catch (e) { console.error(`[build] failed to set building status for ${name}: ${e.message}`) }

  const srcDir = sourceDir(name)
  const outDir = outputDir(name)
  const projDir = projectDir(name)

  // Source-version this build is for: the source.stamp mtime captured at start.
  // The daemon touches source.stamp on every source change, so this is monotonic
  // per change. It's stamped onto the doc-version sentinel and used to guard the
  // (non-blocking, racy) sentinel write so an older build can't clobber it.
  let sourceVersion
  try { sourceVersion = statSync(join(projDir, 'source.stamp')).mtimeMs } catch { sourceVersion = undefined }

  const project = readProject(name)
  if (!project) throw new Error(`Project "${name}" not found`)

  // Targets are derived purely from the source: the primary mainFile plus
  // any sibling X.tex pulled in by `\externaldocument{X}` (xr / xr-hyper).
  // Single-target projects simply have a one-element list. There is no
  // declaration in project.json — the document itself is the source of
  // truth. Output naming uses each target's texBase as a flat prefix, so
  // single-target and multi-target follow the same code path.
  const primary = project.mainFile || 'main.tex'
  const xrSiblings = detectXrSiblings(srcDir, primary)
  const mainFiles = [primary, ...xrSiblings]

  // Validate all targets exist before starting any work.
  for (const mf of mainFiles) {
    if (!existsSync(join(srcDir, mf))) {
      throw new Error(`Main file "${mf}" not found in source`)
    }
  }

  const buildId = `${name}-${++buildIdCounter}`
  const log = []
  const status = {
    building: true,
    buildId,
    startedAt: new Date().toISOString(),
    phase: 'compiling',
    log,
  }
  activeBuilds.set(name, status)

  // Project-level ctx shared across targets — per-target fields (texBase,
  // texPath, texDir, mainFile, buildDir, outDir) are filled in per iteration.
  const ctx = {
    name, project, buildId,
    srcDir, outDir, projDir,
    run: (cmd, opts = {}) => trackedExec(buildId, cmd, opts),
    addLog: (msg) => {
      const line = `[${new Date().toISOString()}] ${msg}`
      log.push(line)
      console.log(`[build:${name}] ${msg}`)
    },
  }
  // Backward-compat: keep top-level ctx.texBase etc. set to the *primary*
  // target so legacy single-target ctx callers still see what they expect.
  ctx.mainFile = mainFiles[0]
  ctx.texBase = basename(ctx.mainFile, '.tex')
  ctx.texPath = join(srcDir, ctx.mainFile)
  ctx.texDir = join(srcDir, dirname(ctx.mainFile))
  // Output dir may not exist (e.g. after a wipe). All targets publish here.
  mkdirSync(outDir, { recursive: true })

  const buildStart = Date.now()
  const elapsed = () => ((Date.now() - buildStart) / 1000).toFixed(1)

  try {
    // Snapshot current output in background — don't block the build
    Promise.resolve().then(() => {
      try {
        const snap = snapshotBeforeBuild(name)
        if (snap) ctx.addLog(`Snapshot saved: ${snap.id} (${snap.pages} pages)`)
      } catch (e) {
        ctx.addLog(`Snapshot failed (non-fatal): ${e.message}`)
      }
    })

    // Per-target phases (compile, publish DVI, extract macros / synctex /
    // proof-pairing / theorem-map / source-map / relevant-files). All
    // outputs land flat in outDir, prefixed by texBase:
    //   outDir/<texBase>.dvi
    //   outDir/<texBase>-page-N.svg              (built lazily, by ensure)
    //   outDir/<texBase>-{lookup,macros,proof-info,source-map,theorem-map,relevant-files}.json
    let totalPages = 0
    const targetMeta = []   // [{ texBase, mainFile, expectedPages }]

    // Order targets by xr dependency: documents pulled in by
    // \externaldocument{X} must be built BEFORE the documents that
    // reference them, since each pdflatex run reads X.aux at compile-time.
    // Mutual cross-refs (cycle) preserve declared order and converge with a
    // second pass.
    const { ordered: orderedMainFiles, hasCycle, hasXrDeps } =
      orderTargetsByXrDeps(mainFiles, srcDir)
    if (orderedMainFiles.join(',') !== mainFiles.join(',')) {
      ctx.addLog(`Targets reordered for xr deps: ${orderedMainFiles.join(' → ')}`)
    }
    const passCount = hasXrDeps ? 2 : 1
    if (passCount > 1) ctx.addLog(`xr cross-refs detected — running ${passCount} passes`)

    for (let pass = 0; pass < passCount; pass++) {
    const isFinalPass = pass === passCount - 1
    for (const mf of orderedMainFiles) {
      const tBase = basename(mf, '.tex')
      const tPath = join(srcDir, mf)
      const tDir = join(srcDir, dirname(mf))
      // Each target gets its own scratch buildDir; outDir is shared and
      // collisions are avoided via texBase-prefixed filenames.
      const tBuildDir = join(tmpdir(), `tlda-build-${name}-${tBase}-${Date.now()}`)
      mkdirSync(tBuildDir, { recursive: true })

      const tCtx = {
        ...ctx,
        mainFile: mf,
        texBase: tBase,
        texPath: tPath,
        texDir: tDir,
        buildDir: tBuildDir,
      }

      convertScratchMarkdown(tDir, tCtx.addLog)

      // Phase 1: LaTeX compilation
      status.phase = 'compiling'
      signalBuildProgress(name, mainFiles.length > 1 ? `compiling ${tBase}` : 'compiling', null)
      const { expectedPages } = await compileLaTeX(tCtx)

      // Phase 2: Publish DVI for on-demand SVG builds, then signal reload.
      // SVGs are built lazily when pages are first requested.
      status.phase = 'converting'
      const dviFile = join(tBuildDir, `${tBase}.dvi`)
      publishFile(dviFile, join(outDir, `${tBase}.dvi`))
      // Drop stale SVGs for THIS target only. Other targets' SVGs (different
      // texBase prefix) are untouched.
      const stalePagePrefix = `${tBase}-page-`
      for (const f of readdirSync(outDir)) {
        if (f.startsWith(stalePagePrefix) && /^.+-page-\d+\.svg$/.test(f)) {
          try { unlinkSync(join(outDir, f)) } catch {}
        }
      }
      tCtx.addLog(`DVI published (${tBase}) — signaling reload`)

      // Phases 3-8: extract macros, synctex, proof pairing, theorem map,
      // source map, relevant files (per-target, written under texBase prefix).
      await extractMacros(tCtx)
      status.phase = 'extracting'
      const hasSynctex = await extractSynctex(tCtx)
      if (hasSynctex) await computeProofPairing(tCtx)
      await generateTheoremMap(tCtx)
      await generateSourceMap(tCtx)
      writeRelevantFiles(tCtx)

      if (isFinalPass) {
        targetMeta.push({ texBase: tBase, mainFile: mf, expectedPages: expectedPages ?? 0 })
        totalPages += expectedPages ?? 0
        saveBuildCache(tCtx)
      }

      // Clean up this target's scratch build dir before the next iteration.
      try { rmSync(tBuildDir, { recursive: true, force: true }) } catch {}
    }
    } // end pass loop

    // Reorder targetMeta back into declared (reading) order — the loop
    // iterates in topo / build order which puts xr-deps first. We want the
    // primary first, dependents after.
    targetMeta.sort((a, b) => mainFiles.indexOf(a.mainFile) - mainFiles.indexOf(b.mainFile))

    // Project-level relevant-files union — daemon's source-change filter
    // uses this to decide whether to rebuild. Combines every target's set.
    {
      const union = new Set()
      for (const t of targetMeta) {
        const p = join(outDir, `${t.texBase}-relevant-files.json`)
        if (existsSync(p)) {
          try {
            const j = JSON.parse(readFileSync(p, 'utf8'))
            for (const f of j.files || []) union.add(f)
          } catch {}
        }
      }
      writeFileSync(
        join(outDir, 'relevant-files.json'),
        JSON.stringify({
          generated_at: new Date().toISOString(),
          source_dir: project?.sourceDir || srcDir,
          targets: targetMeta.map(t => ({ texBase: t.texBase, mainFile: t.mainFile, pages: t.expectedPages })),
          files: [...union].sort(),
        }, null, 2),
      )
    }

    // Send the reload signal once, after all targets finish.
    const svgsReadyAt = Date.now()
    // Snapshot the current build errors/warnings to persist in the sentinel.
    const { errors: buildErrSnapshot, warnings: buildWarnSnapshot } = extractBuildErrors(name)
    signalReload(name, null)

    // Total pages across all targets — what the viewer reports as project.pages.
    const expectedPages = totalPages

    // Finalize. `targets` always reflects the current target set so the
    // viewer doesn't have to special-case single-target — it just renders
    // a one-element list.
    const lastBuildSuccess = readProject(name)?.lastBuildSuccess || null
    _reporter.updateProject(name, {
      pages: expectedPages,
      buildStatus: 'success',
      lastBuild: new Date().toISOString(),
      lastBuildSuccess: new Date().toISOString(),
      targets: targetMeta.map(t => ({ texBase: t.texBase, mainFile: t.mainFile, pages: t.expectedPages })),
    })
    clearSynctexCache(name)

    // Touch build.stamp — staleness counterpart to source.stamp. Replaces
    // the previous role of `output/main.dvi` mtime (which broke once we
    // had multiple per-target DVIs).
    try {
      writeFileSync(join(outDir, 'build.stamp'), String(sourceVersion ?? 0))
    } catch (e) {
      ctx.addLog(`build.stamp write failed (non-fatal): ${e.message}`)
    }

    // Append changelog entry with TeX diff
    try {
      const clEntry = appendBuildEntry(name, [], null)
      if (clEntry) ctx.addLog(`Changelog: diff ${clEntry.texDiff.length} chars`)
    } catch (e) {
      ctx.addLog(`Changelog failed (non-fatal): ${e.message}`)
    }

    const totalElapsed = elapsed()
    ctx.addLog(`Build complete in ${totalElapsed}s`)
    signalBuildProgress(name, 'done', `${totalElapsed}s`)
    emitBuildComplete(name, { status: 'success', elapsed: totalElapsed, pages: expectedPages ?? 0, errors: [] })

    // Bootstrap: if the project's working copy is a git repo AND the shadow
    // doesn't have real history yet, seed the shadow by filtering the
    // working-copy git to paper-scope. Folds into the normal back-and-forth
    // bootstrap — first build computes scope; if there's an extant project
    // git, that scope filters the project's existing history into the shadow.
    // Idempotent: skipped on subsequent builds (shadow already has commits).
    await maybeBootstrapShadowFromProjectRepo(name).catch(e => {
      ctx.addLog(`shadow bootstrap from project repo skipped (non-fatal): ${e.message}`)
    })

    // Commit source snapshot to shadow repo (non-blocking)
    commitSnapshot(name).then(async result => {
      if (!result) {
        // Rebuilds with unchanged source do not create a new shadow commit, but
        // the published SVGs did become ready again. Keep the Yjs sentinel's
        // buildReadyAt in sync so reconnecting viewers do not show an old build
        // timestamp beside fresh project/build state.
        const current = await currentVersion(name)
        if (current?.hash) {
          updateDocVersionSentinel(name, current.hash, svgsReadyAt, buildErrSnapshot, buildWarnSnapshot, sourceVersion).catch(e => {
            ctx.addLog(`doc-version sentinel update failed (non-fatal): ${e.message}`)
          })
        }
        return
      }
      if (result) {
        // Update doc-version sentinel with shadow hash (the build's version identity)
        // plus the build's errors/warnings (persistent, convergent).
        updateDocVersionSentinel(name, result.hash, svgsReadyAt, buildErrSnapshot, buildWarnSnapshot, sourceVersion).catch(e => {
          ctx.addLog(`doc-version sentinel update failed (non-fatal): ${e.message}`)
        })
        recordGitSnapshot(name, { commitHash: result.hash, commitMessage: result.message || `Build at ${new Date().toISOString()}`, pages: expectedPages ?? 0 })
        _reporter.emitGlobalEvent('version-committed', { name, hash: result.hash, timestamp: result.timestamp })
        // Mirror: send the committed shadow snapshot to the daemon that owns the
        // paper working copy and import it there as refs only. The server-local
        // shadow-repo path is not a transport in the multi-machine deployment.
        const hash7 = result.hash.slice(0, 7)
        try {
          if (!mirrorShadowSnapshot) {
            throw new Error('no daemon mirror handler registered')
          }
          const bundleBase64 = await createShadowBundleBase64(name, result.hash)
          const mirrorResult = await mirrorShadowSnapshot({ name, hash: result.hash, bundleBase64 })
          _reporter.updateProject(name, { lastMirrorSuccess: new Date().toISOString(), lastMirrorFailure: null })
          _reporter.writeSentinel(`doc-${name}`, { timestamp: Date.now(), syncErrorJson: '' }).catch(e => {
            ctx.addLog(`sync-error clear failed (non-fatal): ${e.message}`)
          })
          console.log(`[mirror] ${name}@${hash7} ok via daemon ${mirrorResult?.machine_id || 'unknown'} → ${mirrorResult?.sourceDir || 'source repo'}`)
        } catch (mirrorErr) {
          console.error(`[mirror] ${name}@${hash7} failed: ${mirrorErr.message}`)
          ctx.addLog(`mirror to working copy failed (non-fatal): ${mirrorErr.message}`)
          _reporter.updateProject(name, { lastMirrorFailure: { at: new Date().toISOString(), hash: result.hash, message: mirrorErr.message } })
          _reporter.writeSentinel(`doc-${name}`, {
            timestamp: Date.now(),
            sourceVersion,
            syncErrorJson: JSON.stringify([{ kind: 'sync-error', message: `Mirror failed: ${mirrorErr.message}` }]),
          }).catch(e => {
            ctx.addLog(`sync-error sentinel update failed (non-fatal): ${e.message}`)
          })
          // Include lastMirrorSuccess so the failure handler can narrow the responsible-agent
          // window to edits that happened after the last clean mirror.
          const lastMirrorSuccess = readProject(name)?.lastMirrorSuccess || null
          // Include build file list so the handler matches edits to actual build files.
          let buildFiles = null
          try {
            const relPath = join(projDir, 'output', 'relevant-files.json')
            buildFiles = JSON.parse(readFileSync(relPath, 'utf8'))?.files || null
          } catch {}
          _reporter.emitGlobalEvent('build-card', {
            name,
            hash: result.hash.slice(0, 7),
            summary: null,
            lintFindings: [],
            mirrorFailed: mirrorErr.message,
            lastMirrorSuccess,
            buildFiles,
            editedBy: resolveEditedBy(name),
          })
        }
        // Build change summary: diff against previous shadow commit
        try {
          const shadowDir = join(projDir, 'shadow-repo')
          const { stdout: diffOutput } = await _execAsync(
            `git diff HEAD~1 HEAD -- "*.tex" 2>/dev/null || true`,
            { cwd: shadowDir, encoding: 'utf8', timeout: 10000 }
          )
          if (diffOutput.trim()) {
            const summary = summarizeDiff(diffOutput, name)
            console.log(`[build:${name}] Change summary: ${summary ? summary.split('\n').length + ' lines' : 'null'}`)
            // Broadcast viewer signal regardless of lint
            if (summary) {
              _reporter.broadcastSignal(`doc-${name}`, 'signal:build-summary', {
                hash: result.hash.slice(0, 7),
                summary,
                timestamp: Date.now(),
              })
            }
            // BYOL linters: collect all findings, then emit ONE build-card event.
            const lintFindings = []
            try {
              const lintersDir = join(homedir(), '.config', 'tlda', 'linters')
              if (existsSync(lintersDir)) {
                const scripts = readdirSync(lintersDir).filter(f => !f.startsWith('.'))
                for (const script of scripts) {
                  const scriptPath = join(lintersDir, script)
                  try {
                    const output = await new Promise((resolve, reject) => {
                      const child = spawn(process.execPath, [scriptPath], {
                        env: { ...process.env, TLDA_SRCDIR: shadowDir },
                        stdio: ['pipe', 'pipe', 'inherit'],
                      })
                      const chunks = []
                      child.stdout.on('data', d => chunks.push(d))
                      child.stdin.write(diffOutput)
                      child.stdin.end()
                      child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8').trim()))
                      child.on('error', reject)
                    })
                    if (output) {
                      lintFindings.push({ source: script, text: output })
                      console.log(`[build:${name}] Lint (${script}): ${output.split('\n')[0]}`)
                    }
                  } catch (scriptErr) {
                    console.error(`[build:${name}] Lint script ${script} failed:`, scriptErr.message)
                  }
                }
              }
            } catch (lintErr) {
              console.error(`[build:${name}] BYOL lint failed:`, lintErr.message)
            }
            // Emit single build-card event (aggregates summary + all lint findings)
            if (summary || lintFindings.length > 0) {
              let buildFiles = null
              try {
                const relPath = join(projDir, 'output', 'relevant-files.json')
                buildFiles = JSON.parse(readFileSync(relPath, 'utf8'))?.files || null
              } catch {}
              _reporter.emitGlobalEvent('build-card', {
                name,
                hash: result.hash.slice(0, 7),
                summary: summary || null,
                lintFindings,
                buildFiles,
                lastBuildSuccess,
                editedBy: resolveEditedBy(name),
              })
              // Surface lint findings as warnings on the build pill too, alongside
              // tex/remap warnings (re-broadcast preserves the existing tex warnings).
              if (lintFindings.length > 0) {
                signalBuildStatus(name, null, lintFindings.map(f => ({
                  message: f.text, file: null, line: null, category: 'lint',
                })))
              }
            }
          } else {
            console.log(`[build:${name}] No tex diff between shadow commits`)
          }
        } catch (diffErr) { console.error(`[build:${name}] Change summary failed:`, diffErr.message) }
      }
    }).catch(e => {
      ctx.addLog(`shadow-repo commit failed (non-fatal): ${e.message}`)
    })

    status.building = false
    status.phase = 'done'
    status.completedAt = new Date().toISOString()

    writeFileSync(join(projDir, 'build.log'), log.join('\n'))
    return status
  } catch (e) {
    ctx.addLog(`BUILD FAILED: ${e.message}`)
    status.building = false
    status.phase = 'failed'
    status.error = e.message

    try { _reporter.updateProject(name, { buildStatus: 'failed' }) } catch (e2) { console.error(`[build] failed to set failed status for ${name}: ${e2.message}`) }
    try { writeFileSync(join(projDir, 'build.log'), log.join('\n')) } catch (e2) { console.error(`[build] failed to write build.log for ${name}: ${e2.message}`) }

    recordPersistentBuildStatus(name, e.message, sourceVersion)
    signalBuildStatus(name, e.message)
    signalBuildProgress(name, 'failed', e.message)
    emitBuildComplete(name, { status: 'failed', elapsed: elapsed(), errors: [e.message] })
    emitBuildFailureCard(name, e.message)
    throw e
  } finally {
    buildChildProcesses.delete(buildId)
  }
}

// ─── Yjs signals ─────────────────────────────────────────────────────────────

// Viewer pill convention: phase is the fixed-width pill label ("compiling", "converting",
// "patched", "rebuilt", "failed"). detail is quiet text to the right ("biber", "3 pages
// missing", "compiled in 2.1s"). Keep phase to a single word — the pill has min-width 56px.
function signalBuildProgress(name, phase, detail) {
  try {
    _reporter.broadcastSignal(`doc-${name}`, 'signal:build-progress', {
      phase,       // 'compiling' | 'converting' | 'extracting' | 'hot' | 'done' | 'failed'
      detail,      // quiet text beside pill: 'biber' | '3 pages missing' | 'compiled in 2.1s'
      timestamp: Date.now(),
    })
  } catch (e) {
    console.error(`[build:${name}] Failed to send build progress signal: ${e.message}`)
  }
}

function currentBuildStatusPayload(name, errorMessage, extraWarnings = []) {
  const { errors, warnings } = extractBuildErrors(name)
  const signaledErrors = (errorMessage && errors.length === 0)
    ? [{ message: errorMessage, file: 'build' }]
    : errors
  const allWarnings = extraWarnings.length ? [...warnings, ...extraWarnings] : warnings
  return { errors: signaledErrors, warnings: allWarnings }
}

function signalBuildStatus(name, errorMessage, extraWarnings = []) {
  try {
    const { errors, warnings } = currentBuildStatusPayload(name, errorMessage, extraWarnings)
    _reporter.broadcastSignal(`doc-${name}`, 'signal:build-status', {
      error: errorMessage,
      errors,
      warnings,
      timestamp: Date.now(),
    })
    console.log(`[build:${name}] Build status signal sent (${errors.length} errors, ${warnings.length} warnings)`)
  } catch (e) {
    console.error(`[build:${name}] Failed to send build status signal: ${e.message}`)
  }
}

function recordPersistentBuildStatus(name, errorMessage, sourceVersion, extraWarnings = []) {
  try {
    const { errors, warnings } = currentBuildStatusPayload(name, errorMessage, extraWarnings)
    const sv = typeof sourceVersion === 'number' ? sourceVersion : 0
    Promise.resolve(_reporter.writeSentinel(`doc-${name}`, {
      timestamp: Date.now(),
      sourceVersion: sv,
      errorsJson: errors.length ? JSON.stringify(errors) : '',
      warningsJson: warnings.length ? JSON.stringify(warnings) : '',
    })).then(result => {
      if (result?.skipped) {
        console.log(`[build:${name}] skipped out-of-order persistent build status write: source ${sv} ≤ committed`)
        return
      }
      console.log(`[build:${name}] persistent build status updated: src=${sv} (${errors.length} errors, ${warnings.length} warnings)`)
    }).catch(e => console.error(`[build:${name}] persistent build status relay failed: ${e.message}`))
  } catch (e) {
    console.error(`[build:${name}] Failed to update persistent build status: ${e.message}`)
  }
}

function emitBuildFailureCard(name, message) {
  let errors = []
  let warnings = []
  try {
    const parsed = currentBuildStatusPayload(name, message)
    errors = parsed.errors || []
    warnings = parsed.warnings || []
  } catch (e) {
    console.error(`[build:${name}] extractBuildErrors for build-card failed: ${e.message}`)
  }
  let buildFiles = null
  const relPath = join(projectDir(name), 'output', 'relevant-files.json')
  if (existsSync(relPath)) {
    buildFiles = JSON.parse(readFileSync(relPath, 'utf8'))?.files || null
  }
  _reporter.emitGlobalEvent('build-card', {
    name,
    hash: null,
    summary: null,
    lintFindings: [],
    buildFailed: message,
    errors: errors.slice(0, 5),
    warnings: warnings.slice(0, 5),
    buildFiles,
    lastBuildSuccess: readProject(name)?.lastBuild || null,
    editedBy: resolveEditedBy(name),
  })
}

// Edit attribution: the daemon records who last Edited/Wrote a source file and
// stamps lastEditedBy/lastEditedByAt on the project when it pushes a change.
// Return that agent if the edit is recent enough to plausibly be the trigger.
const EDIT_ATTRIBUTION_WINDOW_MS = 10 * 60 * 1000
function resolveEditedBy(name) {
  try {
    const proj = readProject(name)
    if (proj?.lastEditedBy && proj.lastEditedByAt &&
        Date.now() - proj.lastEditedByAt < EDIT_ATTRIBUTION_WINDOW_MS) {
      return proj.lastEditedBy
    }
  } catch (e) {
    console.error(`[build:${name}] resolveEditedBy failed: ${e.message}`)
  }
  return null
}

function signalReload(name, pages) {
  try {
    const signal = pages
      ? { type: 'partial', pages, timestamp: Date.now() }
      : { type: 'full', timestamp: Date.now() }
    _reporter.broadcastSignal(`doc-${name}`, 'signal:reload', signal)
    const desc = pages ? `pages [${pages.join(',')}]` : 'full'
    console.log(`[build:${name}] Reload signal (${desc}) sent`)
  } catch (e) {
    console.error(`[build:${name}] Failed to send reload signal: ${e.message}`)
  }
}

/**
 * Update the doc-version sentinel shape in the Yjs room with the current
 * source git commit hash. Fire-and-forget — call without await.
 */
async function updateDocVersionSentinel(name, shadowHash, buildReadyAt, errors, warnings, sourceVersion) {
  const commitHash = shadowHash || 'unknown'
  const docName = `doc-${name}`
  const sv = typeof sourceVersion === 'number' ? sourceVersion : 0
  const result = await _reporter.writeSentinel(docName, {
    commitHash,
    timestamp: Date.now(),
    buildReadyAt: buildReadyAt || Date.now(),
    // sourceVersion = the source.stamp mtime this build was for, monotonic per
    // source change. The shared sentinel writer drops older build writes so the
    // version can never jump backward.
    sourceVersion: sv,
    // Build errors/warnings live HERE — convergent Yjs state, not a
    // fire-and-forget signal. A build's error status is a stable property
    // that must survive reconnect/restart, so the viewer reads it straight
    // from the sentinel (single source of truth, no signal fallback).
    warningsJson: warnings ? JSON.stringify(warnings) : '',
    errorsJson: errors ? JSON.stringify(errors) : '',
  })
  if (result.skipped) {
    console.log(`[build:${name}] skipped out-of-order sentinel write: source ${sv} ≤ committed`)
    return
  }
  console.log(`[build:${name}] doc-version sentinel updated: ${commitHash.slice(0, 7)} src=${sv} (${errors?.length || 0} errors, ${warnings?.length || 0} warnings)`)
}
