/**
 * Build runner for TeX projects.
 *
 * Runs the build pipeline as child processes:
 *   1. latexmk → DVI + synctex
 *   2. Publish main.dvi to output/, clear stale SVGs, signal reload
 *   3. extract-preamble.js → macros.json
 *   4. extract-synctex-lookup.mjs → lookup.json
 *   5. compute-proof-pairing.mjs → proof-info.json
 *
 * SVG pages are built on demand by buildCurrentPage() (shadow-repo.mjs) when
 * the client requests them. The build never runs dvisvgm — ensure does.
 * Each step writes output to server/projects/{name}/output/.
 */

import { exec as execCb, execSync } from 'child_process'
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
import { existsSync, readdirSync, writeFileSync, readFileSync, unlinkSync, renameSync, mkdirSync, cpSync, rmSync, statSync, realpathSync } from 'fs'
import { createHash } from 'crypto'
import { join, basename, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { updateProject, sourceDir, outputDir, projectDir, readProject, listProjects, extractBuildErrors } from './project-store.mjs'
import { broadcastSignal, putShape, emitGlobalEvent } from './sync-rooms.mjs'
import { snapshotBeforeBuild, recordGitSnapshot } from './history-store.mjs'
import { commitSnapshot } from './shadow-repo.mjs'
import { appendBuildEntry } from './changelog.mjs'
import { emitBuildComplete } from './webhooks.mjs'
import { clearSynctexCache } from './synctex-query.mjs'

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

/** Hash the actual published SVGs on disk — no cached JSON that can drift. */
function loadPageHashes(outDir) {
  const hashes = {}
  try {
    for (const f of readdirSync(outDir)) {
      if (/^page-\d+\.svg$/.test(f)) {
        hashes[f] = hashSvgContent(readFileSync(join(outDir, f), 'utf8'))
      }
    }
  } catch { /* outDir doesn't exist yet */ }
  return hashes
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
        ? `biber --input-directory="${texDir}" --output-directory="${buildDir}" "${join(buildDir, texBase)}"`
        : `BIBINPUTS="${texDir}:${srcDir}:" BSTINPUTS="${texDir}:${srcDir}:" bibtex "${join(buildDir, texBase)}"`
      const bibTool = useBiblatex ? 'biber' : 'bibtex'
      // Remove stale .bbl — if we're here, citations are broken anyway.
      // Prevents format-switch corruption (biblatex↔bibtex cached .bbl).
      if (existsSync(bblPath)) unlinkSync(bblPath)
      addLog(`Running ${bibTool} for citations...`)
      signalBuildProgress(name, 'compiling', bibTool)
      let bibFailed = false
      try {
        await run(bibCmd, { cwd: buildDir, timeout: 60000 })
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
            addLog('Biber failed — cleaning state files and PAR cache, retrying')
            const cleanExts = ['.bcf', '.bbl', '.blg', '.run.xml']
            for (const ext of cleanExts) {
              const f = join(buildDir, `${texBase}${ext}`)
              if (existsSync(f)) { try { unlinkSync(f) } catch {} }
              // Also clean from build cache so corruption doesn't persist
              const cacheF = join(projDir, 'build-cache', `${texBase}${ext}`)
              if (existsSync(cacheF)) { try { unlinkSync(cacheF) } catch {} }
            }
            // Clean biber's PAR cache — delete only the corrupt unicore/ dir
            try {
              const tmpDir = process.env.TMPDIR || '/tmp'
              for (const d of readdirSync(tmpDir)) {
                if (!d.startsWith('par-')) continue
                const parDir = join(tmpDir, d)
                for (const sub of readdirSync(parDir)) {
                  if (!sub.startsWith('cache-')) continue
                  const unicorePath = join(parDir, sub, 'inc', 'lib', 'unicore')
                  if (existsSync(unicorePath)) {
                    try {
                      for (const f of readdirSync(unicorePath)) unlinkSync(join(unicorePath, f))
                      addLog('Cleaned corrupt biber unicore cache')
                    } catch {}
                  }
                }
              }
            } catch {}
            // Retry biber
            try {
              await run(bibCmd, { cwd: buildDir, timeout: 60000 })
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
      try { await run(cmd, { cwd: texDir, timeout: 120000, env }) } catch {}
      const finalLog = readFileSync(logPath, 'utf8')
      const stillUndefined = (finalLog.match(/Citation .* undefined/g) || []).length
      if (stillUndefined > 5 && existsSync(bcfPath)) {
        addLog(`${stillUndefined} citations still undefined — cleaning biber state and retrying`)
        const cleanExts = ['.bcf', '.bbl', '.blg', '.run.xml']
        for (const ext of cleanExts) {
          const f = join(buildDir, `${texBase}${ext}`)
          if (existsSync(f)) { try { unlinkSync(f) } catch {} }
          const cacheF = join(projDir, 'build-cache', `${texBase}${ext}`)
          if (existsSync(cacheF)) { try { unlinkSync(cacheF) } catch {} }
        }
        // Clean biber PAR cache — delete the specific unicore/ dir that corrupts
        try {
          const tmpDir = process.env.TMPDIR || '/tmp'
          for (const d of readdirSync(tmpDir)) {
            if (!d.startsWith('par-')) continue
            const parDir = join(tmpDir, d)
            for (const sub of readdirSync(parDir)) {
              if (!sub.startsWith('cache-')) continue
              const unicorePath = join(parDir, sub, 'inc', 'lib', 'unicore')
              if (existsSync(unicorePath)) {
                // Only delete the corrupted unicore dir, not the whole cache
                try {
                  for (const f of readdirSync(unicorePath)) unlinkSync(join(unicorePath, f))
                  addLog('Cleaned corrupt biber unicore cache')
                } catch {}
              }
            }
          }
        } catch {}
        const bibCmd2 = `biber --input-directory="${texDir}" --output-directory="${buildDir}" "${join(buildDir, texBase)}"`
        try {
          await run(bibCmd2, { cwd: buildDir, timeout: 60000 })
          await run(cmd, { cwd: texDir, timeout: 120000, env })
          addLog('Citation recovery succeeded')
        } catch (e) {
          addLog(`Citation recovery failed: ${e.message?.split('\n')[0]}`)
        }
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
    const joined = raw.split('\n').reduce((acc, line) => {
      if (acc.length > 0 && acc[acc.length - 1].length === 79) {
        acc[acc.length - 1] += line
      } else {
        acc.push(line)
      }
      return acc
    }, []).join('\n')
    const m = joined.match(/Output written on .+\((\d+) pages?/)
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
  // mainFile may have a subdir prefix (e.g. "revision/foo.tex"), so use dirname(mainFile).
  cpSync(synctexFile, join(srcDir, dirname(mainFile), `${texBase}.synctex.gz`))

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

/** Phase 7: Generate source-map.json — unified client index.
 * Combines synctex positions + label data into one file:
 * - labels: all \label{} items with page, position, type, number
 * - pages: per-page line index (y → file:line) for forward/reverse lookup
 */
async function generateSourceMap(ctx) {
  const { name, texBase, buildDir, outDir, srcDir, addLog } = ctx
  const { loadSynctex } = await import('./synctex-query.mjs')

  try {
    const synctex = await loadSynctex(name)
    if (!synctex) { addLog('Source map: no synctex data'); return }

    // Build per-page line index: sorted list of { y, file, line }
    // Deduplicate by file:line (keep the first y for each source location)
    const pageIndex = {}
    const seen = new Set()
    for (const r of synctex.records) {
      const filePath = synctex.inputMap.get(r.inputId)
      if (!filePath || !filePath.endsWith('.tex')) continue
      // Derive relative file name
      let relFile = filePath
      try {
        const realSrcDir = realpathSync(sourceDir(name))
        if (filePath.startsWith(realSrcDir)) relFile = filePath.slice(realSrcDir.length + 1)
      } catch {}
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

    // Load labels from the already-generated labels.json
    const labelsPath = join(outDir, 'labels.json')
    let labels = []
    if (existsSync(labelsPath)) {
      labels = JSON.parse(readFileSync(labelsPath, 'utf8'))
    }

    const sourceMap = { labels, pages: pageIndex }
    const outPath = join(outDir, 'source-map.json')
    writeFileSync(outPath, JSON.stringify(sourceMap))
    const sizeKB = Math.round(statSync(outPath).size / 1024)
    addLog(`Source map: ${labels.length} labels, ${Object.keys(pageIndex).length} pages (${sizeKB} KB)`)
  } catch (e) {
    addLog(`Source map generation failed: ${e.message}`)
  }
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
  publishFile(tmpPath, join(outDir, 'theorem-map.json'))

  // Also write labels.json — comprehensive label index for the client source map
  const labelsPath = join(buildDir, 'labels.json')
  writeFileSync(labelsPath, JSON.stringify(entries))
  publishFile(labelsPath, join(outDir, 'labels.json'))
  addLog(`Theorem map: ${entries.length} entries (${Object.keys(map).length} named, ${entries.length - Object.keys(map).length} other labels)`)
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
  const relevant = new Set()
  let lineCount = 0
  try {
    const fls = readFileSync(flsPath, 'utf8')
    for (const line of fls.split('\n')) {
      if (!line.startsWith('INPUT ')) continue
      lineCount++
      let p = line.slice(6).trim()
      if (!p) continue
      // Absolute paths from texlive / system libs: skip.
      if (p.startsWith('/') && !p.startsWith(srcDir) && !(authorDir && p.startsWith(authorDir))) continue
      // Relative paths: resolve against srcDir (cwd of pdflatex).
      if (!p.startsWith('/')) p = join(srcDir, p)
      // Normalize — collapse any .. / . segments.
      try { p = realpathSync(p) } catch { /* file may not exist anymore */ }
      // Only keep paths inside srcDir (the mirror) — translate to authorDir.
      if (p.startsWith(srcDir + '/')) {
        const rel = p.slice(srcDir.length + 1)
        if (authorDir) relevant.add(join(authorDir, rel))
        relevant.add(p)  // also keep mirror path for safety
      } else if (authorDir && p.startsWith(authorDir + '/')) {
        relevant.add(p)
      }
    }
  } catch (e) {
    addLog(`Relevant files: parse failed (non-fatal): ${e.message}`)
    return
  }
  const outPath = join(outDir, 'relevant-files.json')
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

// ─── Exported helpers ────────────────────────────────────────────────────────

export function emitDocArrived(name) {
  try {
    const updated = readProject(name)
    if (updated?.buildStatus === 'success') {
      emitGlobalEvent('doc-arrived', {
        name, title: updated.title || name,
        format: updated.format, pages: updated.pages || 0,
      })
    }
  } catch {}
}

// ─── Lazy DVI ensure ─────────────────────────────────────────────────────────

/**
 * Ensure the current DVI is up to date.
 * Triggered by buildCurrentPage when a page is requested.
 * If a source.stamp file exists that is newer than main.dvi, the project is
 * stale and a full build runs. Multiple concurrent callers share one build.
 */
const _ensureCurrentDviInflight = new Map()

export async function ensureCurrentDvi(name) {
  const outDir = outputDir(name)
  const dviFile = join(outDir, 'main.dvi')
  const stampFile = join(projectDir(name), 'source.stamp')

  const needsBuild = !existsSync(dviFile) ||
    (existsSync(stampFile) && statSync(stampFile).mtimeMs > statSync(dviFile).mtimeMs)

  if (!needsBuild) return dviFile

  // Already building — coalesce
  if (_ensureCurrentDviInflight.has(name)) return _ensureCurrentDviInflight.get(name)

  const building = runBuild(name)
    .then(() => {
      emitDocArrived(name)
      return dviFile
    })
    .finally(() => _ensureCurrentDviInflight.delete(name))
  _ensureCurrentDviInflight.set(name, building)
  return building
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export async function runBuild(name, { priorityPages: explicitPriority } = {}) {
  // If no priority pages specified, try the signal cache (what the viewer last reported)
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
  // If mainFile has a directory prefix (e.g. "revision/manuscript.tex"),
  // the compilation cwd must be that subdirectory so pdflatex finds the file.
  const texDir = join(srcDir, dirname(mainFile))

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

  const buildDir = join(tmpdir(), `tlda-build-${name}-${Date.now()}`)
  mkdirSync(buildDir, { recursive: true })

  const ctx = {
    name, project, buildId,
    srcDir, outDir, projDir, buildDir,
    texBase, texPath, texDir, mainFile,
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
    const { expectedPages } = await compileLaTeX(ctx)

    // Phase 2: Publish DVI for on-demand SVG builds, then signal reload.
    // SVGs are built lazily when pages are first requested (see buildCurrentPage).
    status.phase = 'converting'
    const dviFile = join(buildDir, `${texBase}.dvi`)
    publishFile(dviFile, join(outDir, 'main.dvi'))
    // Clear stale SVGs — clients will request them on demand after the reload signal
    for (const f of readdirSync(outDir)) {
      if (/^page-\d+\.svg$/.test(f)) {
        try { unlinkSync(join(outDir, f)) } catch {}
      }
    }
    ctx.addLog(`DVI published — signaling reload`)
    signalReload(name, null)

    // Phase 3: Macro extraction
    await extractMacros(ctx)

    // Phase 4+5: Synctex → proof pairing (sequential, post-reload)
    status.phase = 'extracting'
    const hasSynctex = await extractSynctex(ctx)
    if (hasSynctex) await computeProofPairing(ctx)

    // Phase 6: Theorem map
    await generateTheoremMap(ctx)

    // Phase 7: Source map — unified index for the client
    await generateSourceMap(ctx)

    // Phase 8: Relevant-files set (for source-change filtering). Parses
    // the .fls file that pdflatex -recorder wrote and captures every
    // INPUT path that lives inside the project's sourceDir.
    writeRelevantFiles(ctx)

    // Finalize
    updateProject(name, {
      pages: expectedPages ?? 0,
      buildStatus: 'success',
      lastBuild: new Date().toISOString(),
    })
    saveBuildCache(ctx)
    clearSynctexCache(name)

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

    // Update doc-version sentinel shape with source git commit hash (non-blocking)
    updateDocVersionSentinel(name, ctx.srcDir).catch(e => {
      ctx.addLog(`doc-version sentinel update failed (non-fatal): ${e.message}`)
    })

    // Commit source snapshot to shadow repo (non-blocking)
    commitSnapshot(name).then(result => {
      if (result) {
        recordGitSnapshot(name, { commitHash: result.hash, commitMessage: result.message || `Build at ${new Date().toISOString()}`, pages: expectedPages ?? 0 })
        emitGlobalEvent('version-committed', { name, hash: result.hash, timestamp: result.timestamp })
        // Tag the source repo with the shadow hash so agents can `git checkout shadow/<hash>`
        try {
          const project = readProject(name)
          if (project?.sourceDir && existsSync(join(project.sourceDir, '.git'))) {
            const tag = `shadow/${result.hash.slice(0, 7)}`
            execSync(`git tag -f "${tag}"`, { cwd: project.sourceDir, stdio: 'pipe', timeout: 5000 })
          }
        } catch {}
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

    try { updateProject(name, { buildStatus: 'failed' }) } catch {}
    try { writeFileSync(join(projDir, 'build.log'), log.join('\n')) } catch {}

    signalBuildStatus(name, e.message)
    signalBuildProgress(name, 'failed', e.message)
    emitBuildComplete(name, { status: 'failed', elapsed: elapsed(), errors: [e.message] })
    throw e
  } finally {
    buildChildProcesses.delete(buildId)
    try { rmSync(buildDir, { recursive: true, force: true }) } catch {}
  }
}

// ─── Yjs signals ─────────────────────────────────────────────────────────────

// Viewer pill convention: phase is the fixed-width pill label ("compiling", "converting",
// "patched", "rebuilt", "failed"). detail is quiet text to the right ("biber", "3 pages
// missing", "compiled in 2.1s"). Keep phase to a single word — the pill has min-width 56px.
function signalBuildProgress(name, phase, detail) {
  try {
    broadcastSignal(`doc-${name}`, 'signal:build-progress', {
      phase,       // 'compiling' | 'converting' | 'extracting' | 'hot' | 'done' | 'failed'
      detail,      // quiet text beside pill: 'biber' | '3 pages missing' | 'compiled in 2.1s'
      timestamp: Date.now(),
    })
  } catch (e) {
    console.error(`[build:${name}] Failed to send build progress signal: ${e.message}`)
  }
}

function signalBuildStatus(name, errorMessage) {
  try {
    const { errors, warnings } = extractBuildErrors(name)
    broadcastSignal(`doc-${name}`, 'signal:build-status', {
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

function signalReload(name, pages) {
  try {
    const signal = pages
      ? { type: 'partial', pages, timestamp: Date.now() }
      : { type: 'full', timestamp: Date.now() }
    broadcastSignal(`doc-${name}`, 'signal:reload', signal)
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
async function updateDocVersionSentinel(name, srcDir) {
  let commitHash = 'unknown'
  if (srcDir && existsSync(srcDir)) {
    try {
      const { stdout } = await execAsync('git rev-parse HEAD', { cwd: srcDir, timeout: 5000 })
      commitHash = stdout.trim()
    } catch {
      // Not a git repo, or no commits yet — leave as 'unknown'
    }
  }

  const docName = `doc-${name}`
  const sentinel = {
    id: 'shape:doc-version--sentinel',
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
      commitHash,
      timestamp: Date.now(),
    },
  }

  await putShape(docName, sentinel)
  console.log(`[build:${name}] doc-version sentinel updated: ${commitHash.slice(0, 7)}`)
}
