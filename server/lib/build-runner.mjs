/**
 * Build runner for TeX projects.
 *
 * Runs the build pipeline as child processes:
 *   1. latexmk → DVI + synctex
 *   2. dvisvgm → SVG pages (priority pages first if specified)
 *   3. extract-preamble.js → macros.json
 *   4. extract-synctex-lookup.mjs → lookup.json
 *   5. compute-proof-pairing.mjs → proof-info.json
 *
 * Each step writes output to server/projects/{name}/output/.
 * Signals reload via Yjs after SVG conversion.
 */

import { exec as execCb } from 'child_process'
import { promisify } from 'util'
const _execAsync = promisify(execCb)
// Ensure TeX binaries are available (launchd doesn't inherit full shell PATH)
const texbin = '/Library/TeX/texbin'
if (!process.env.PATH?.includes(texbin)) {
  process.env.PATH = `${texbin}:${process.env.PATH || '/usr/bin:/bin'}`
}
const execAsync = (cmd, opts = {}) => _execAsync(cmd, { maxBuffer: 50 * 1024 * 1024, ...opts })
import { existsSync, readdirSync, writeFileSync, readFileSync, unlinkSync, renameSync, mkdirSync, cpSync, rmSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { join, basename, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { updateProject, sourceDir, outputDir, projectDir, readProject, listProjects, extractBuildErrors } from './project-store.mjs'
import { getDoc } from './yjs-sync.mjs'
import { snapshotBeforeBuild } from './history-store.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..', '..')
const SCRIPTS_DIR = join(PROJECT_ROOT, 'scripts')

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
    // Skip if PDF already exists and is newer
    if (existsSync(pdfPath)) {
      try {
        const svgStat = statSync(svgPath)
        const pdfStat = statSync(pdfPath)
        if (pdfStat.mtimeMs >= svgStat.mtimeMs) continue
      } catch {}
    }
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
    // Write minimal PDF — just enough for LaTeX to read the MediaBox
    const pdf = `%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 ${w} ${h}]/Parent 2 0 R>>endobj
xref
0 4
0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>
startxref
190
%%EOF`
    writeFileSync(pdfPath, pdf)
    count++
  }
  if (count > 0) addLog(`Generated ${count} stub PDF(s) from SVG figures`)
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
  } catch {}
  return results
}

function loadPageHashes(outDir) {
  try {
    return JSON.parse(readFileSync(join(outDir, 'page-hashes.json'), 'utf8'))
  } catch {
    return {}
  }
}

function savePageHashes(outDir, hashes) {
  writeFileSync(join(outDir, 'page-hashes.json'), JSON.stringify(hashes, null, 2))
}

// ─── Build state management ──────────────────────────────────────────────────

// Active builds tracked in memory
const activeBuilds = new Map()

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
      updateProject(project.name, { buildStatus: 'stale' })
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
const PRETEX = '\\PassOptionsToPackage{draft}{graphicx}\\PassOptionsToPackage{hypertex,hidelinks}{hyperref}\\AddToHook{begindocument/before}{\\RequirePackage{hyperref}}'

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

  const preamble = extractPreamble(join(srcDir, `${texBase}.tex`))
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
async function compileLaTeX(ctx) {
  const { name, srcDir, buildDir, projDir, texBase, addLog, run } = ctx
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
  generateStubPdfs(srcDir, addLog)

  // Try to use precompiled preamble format
  const fmtBase = await ensureFormat(ctx)

  // TEXMFOUTPUT lets pdflatex write to buildDir even with cwd=srcDir.
  // TEXINPUTS ensures pdflatex finds .aux/.bbl in buildDir alongside srcDir.
  const env = {
    ...process.env,
    TEXMFOUTPUT: buildDir,
    TEXINPUTS: `${buildDir}:${srcDir}:`,
  }

  // Build the pdflatex command — cwd is srcDir, output goes to buildDir
  let cmd
  if (fmtBase) {
    cmd = `pdflatex --output-format=dvi -synctex=1 -interaction=nonstopmode ` +
      `-output-directory="${buildDir}" -fmt="${fmtBase}" "${texBase}.tex"`
  } else {
    addLog('No format available — using pretex wrapper')
    const wrapperContent = PRETEX + '\n\\input{' + texBase + '.tex}\n'
    writeFileSync(join(buildDir, `${texBase}-wrapped.tex`), wrapperContent)
    cmd = `pdflatex --output-format=dvi -synctex=1 -interaction=nonstopmode ` +
      `-output-directory="${buildDir}" -jobname="${texBase}" "${texBase}-wrapped.tex"`
  }

  const compileStart = Date.now()
  addLog(`Compiling${fmtBase ? ' (fmt)' : ''}...`)
  try {
    await run(cmd, { cwd: srcDir, timeout: 120000, env })
  } catch (e) {
    addLog(`pdflatex exited with warnings (continuing): ${e.message.split('\n')[0]}`)
  }

  // Check if a second pass is needed (unresolved references)
  const logPath = join(buildDir, `${texBase}.log`)
  if (existsSync(logPath)) {
    const logText = readFileSync(logPath, 'utf8')
    if (logText.includes('Label(s) may have changed') || logText.includes('Rerun to get')) {
      addLog('References changed — running second pass')
      try {
        await run(cmd, { cwd: srcDir, timeout: 120000, env })
      } catch {}
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
}

/**
 * Phase 2: SVG conversion + incremental publish.
 * Converts DVI pages, patches image placeholders, hashes to detect changes,
 * publishes only changed pages, and signals partial/full reload.
 *
 * Returns { pageCount, newHashes }.
 */
async function convertSvgs(ctx, priorityPages, oldHashes) {
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
    } catch {}
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

  savePageHashes(outDir, newHashes)
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

  return { pageCount, newHashes }
}

/** Phase 3: Extract macros from preamble. */
async function extractMacros(ctx) {
  const { texPath, buildDir, outDir, addLog, run } = ctx
  addLog('Extracting preamble macros...')
  try {
    await run(
      `node "${join(SCRIPTS_DIR, 'extract-preamble.js')}" "${texPath}" "${join(buildDir, 'macros.json')}"`,
      { cwd: PROJECT_ROOT },
    )
    publishFile(join(buildDir, 'macros.json'), join(outDir, 'macros.json'))
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
  cpSync(synctexFile, join(srcDir, `${texBase}.synctex.gz`))

  addLog('Extracting synctex lookup...')
  const synctexStart = Date.now()
  try {
    await run(
      `node "${join(SCRIPTS_DIR, 'extract-synctex-lookup.mjs')}" "${join(srcDir, mainFile)}" "${join(buildDir, 'lookup.json')}"`,
      { cwd: PROJECT_ROOT, timeout: 600000 },
    )
    publishFile(join(buildDir, 'lookup.json'), join(outDir, 'lookup.json'))
    addLog(`Synctex done in ${((Date.now() - synctexStart) / 1000).toFixed(1)}s`)
    return true
  } catch (e) {
    addLog(`Synctex extraction failed (non-fatal): ${e.message}`)
    return false
  }
}

/** Phase 5: Compute proof pairing (depends on lookup.json). */
async function computeProofPairing(ctx) {
  const { texPath, buildDir, outDir, addLog, run } = ctx
  addLog('Computing proof pairing...')
  try {
    await run(
      `node "${join(SCRIPTS_DIR, 'compute-proof-pairing.mjs')}" "${texPath}" ` +
      `"${join(buildDir, 'lookup.json')}" "${join(buildDir, 'proof-info.json')}"`,
      { cwd: PROJECT_ROOT, timeout: 120000 },
    )
    publishFile(join(buildDir, 'proof-info.json'), join(outDir, 'proof-info.json'))
  } catch (e) {
    addLog(`Proof pairing failed (non-fatal): ${e.message}`)
  }
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

// ─── Orchestrator ────────────────────────────────────────────────────────────

export async function runBuild(name, { priorityPages: explicitPriority } = {}) {
  // If no priority pages specified, read viewport from Yjs (what the viewer is looking at)
  let priorityPages = explicitPriority
  if (!priorityPages) {
    try {
      const roomId = `doc-${name}`
      const doc = getDoc(roomId)
      const yRecords = doc.getMap('tldraw')
      const viewport = yRecords.get('signal:viewport')
      if (viewport?.pages?.length > 0) {
        priorityPages = viewport.pages
      }
    } catch {}
  }
  // Fallback: at least page 1
  if (!priorityPages || priorityPages.length === 0) {
    priorityPages = [1]
  }
  // If a build is already running, kill it and restart
  const existing = activeBuilds.get(name)
  if (existing?.building) {
    console.log(`[build:${name}] Killing in-progress build, restarting`)
    killBuildProcesses(existing.buildId)
    await new Promise(r => setTimeout(r, 1000))
    existing.building = false
    existing.phase = 'cancelled'
  }

  // Set buildStatus early — before any validation that might throw.
  try { updateProject(name, { buildStatus: 'building', lastBuild: new Date().toISOString() }) } catch {}

  const srcDir = sourceDir(name)
  const outDir = outputDir(name)
  const projDir = projectDir(name)

  const project = readProject(name)
  if (!project) throw new Error(`Project "${name}" not found`)

  const mainFile = project.mainFile || 'main.tex'
  const texBase = basename(mainFile, '.tex')
  const texPath = join(srcDir, mainFile)

  if (!existsSync(texPath)) {
    throw new Error(`Main file "${mainFile}" not found in source`)
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

  const buildDir = join(tmpdir(), `ctd-build-${name}-${Date.now()}`)
  mkdirSync(buildDir, { recursive: true })

  const ctx = {
    name, project, buildId,
    srcDir, outDir, projDir, buildDir,
    texBase, texPath, mainFile,
    run: (cmd, opts = {}) => trackedExec(buildId, cmd, opts),
    addLog: (msg) => {
      const line = `[${new Date().toISOString()}] ${msg}`
      log.push(line)
      console.log(`[build:${name}] ${msg}`)
    },
  }

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

    const buildStart = Date.now()
    const elapsed = () => ((Date.now() - buildStart) / 1000).toFixed(1)

    // Phase 1: LaTeX compilation
    status.phase = 'compiling'
    signalBuildProgress(name, 'compiling', null)
    await compileLaTeX(ctx)

    // Phase 2+3: SVG conversion and macro extraction run in parallel
    status.phase = 'converting'
    signalBuildProgress(name, 'converting', `compiled in ${elapsed()}s`)
    const oldHashes = loadPageHashes(outDir)
    const [svgResult] = await Promise.all([
      convertSvgs(ctx, priorityPages, oldHashes),
      extractMacros(ctx),
    ])

    // Phase 4+5: Synctex → proof pairing (sequential, post-reload)
    status.phase = 'extracting'
    const hasSynctex = await extractSynctex(ctx)
    if (hasSynctex) await computeProofPairing(ctx)

    // Finalize
    updateProject(name, {
      pages: svgResult.pageCount,
      buildStatus: 'success',
      lastBuild: new Date().toISOString(),
    })
    saveBuildCache(ctx)

    const totalElapsed = elapsed()
    ctx.addLog(`Build complete in ${totalElapsed}s`)
    signalBuildProgress(name, 'done', `${totalElapsed}s`)

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

    try { updateProject(name, { buildStatus: 'failed' }) } catch {}
    try { writeFileSync(join(projDir, 'build.log'), log.join('\n')) } catch {}

    signalBuildStatus(name, e.message)
    signalBuildProgress(name, 'failed', e.message)
    throw e
  } finally {
    buildChildProcesses.delete(buildId)
    try { rmSync(buildDir, { recursive: true, force: true }) } catch {}
  }
}

// ─── Yjs signals ─────────────────────────────────────────────────────────────

function signalBuildProgress(name, phase, detail) {
  try {
    const roomId = `doc-${name}`
    const doc = getDoc(roomId)
    const yRecords = doc.getMap('tldraw')
    doc.transact(() => {
      yRecords.set('signal:build-progress', {
        phase,       // 'compiling' | 'converting' | 'extracting' | 'done' | 'failed'
        detail,      // e.g. 'latexmk' | 'priority pages [3,5]' | 'all pages' | '12.3s'
        timestamp: Date.now(),
      })
    })
  } catch (e) {
    console.error(`[build:${name}] Failed to send build progress signal: ${e.message}`)
  }
}

function signalBuildStatus(name, errorMessage) {
  try {
    const roomId = `doc-${name}`
    const doc = getDoc(roomId)
    const yRecords = doc.getMap('tldraw')

    const { errors, warnings } = extractBuildErrors(name)

    doc.transact(() => {
      yRecords.set('signal:build-status', {
        error: errorMessage,
        errors,
        warnings,
        timestamp: Date.now(),
      })
    })
    console.log(`[build:${name}] Build status signal sent (${errors.length} errors, ${warnings.length} warnings)`)
  } catch (e) {
    console.error(`[build:${name}] Failed to send build status signal: ${e.message}`)
  }
}

function signalReload(name, pages) {
  try {
    const roomId = `doc-${name}`
    const doc = getDoc(roomId)
    const yRecords = doc.getMap('tldraw')

    const signal = pages
      ? { type: 'partial', pages, timestamp: Date.now() }
      : { type: 'full', timestamp: Date.now() }

    doc.transact(() => {
      yRecords.set('signal:reload', signal)
    })

    const desc = pages ? `pages [${pages.join(',')}]` : 'full'
    console.log(`[build:${name}] Reload signal (${desc}) sent`)
  } catch (e) {
    console.error(`[build:${name}] Failed to send reload signal: ${e.message}`)
  }
}
