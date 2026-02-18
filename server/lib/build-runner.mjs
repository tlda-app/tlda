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

export async function runBuild(name, { priorityPages } = {}) {
  // If a build is already running, kill it and restart
  const existing = activeBuilds.get(name)
  if (existing?.building) {
    console.log(`[build:${name}] Killing in-progress build, restarting`)
    killBuildProcesses(existing.buildId)
    // Wait for processes to actually die
    await new Promise(r => setTimeout(r, 1000))
    existing.building = false
    existing.phase = 'cancelled'
  }

  // Set buildStatus early — before any validation that might throw.
  // This prevents the watcher from seeing stale 'success' if we fail before updateProject.
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

  const run = (cmd, opts = {}) => trackedExec(buildId, cmd, opts)

  const addLog = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`
    log.push(line)
    console.log(`[build:${name}] ${msg}`)
  }

  // Fresh temp dir per build — no stale .aux/.dvi from killed builds
  const buildDir = join(tmpdir(), `ctd-build-${name}-${Date.now()}`)

  try {
    // Snapshot current output before overwriting
    try {
      const snap = snapshotBeforeBuild(name)
      if (snap) addLog(`Snapshot saved: ${snap.id} (${snap.pages} pages)`)
    } catch (e) {
      addLog(`Snapshot failed (non-fatal): ${e.message}`)
    }

    // Phase 1: LaTeX compilation in a fresh build directory.
    // Source files are copied in, then seeded with cached .aux/.bbl from the
    // last successful build (faster incremental builds, resolved cross-refs).
    // Killed builds never pollute the cache.
    addLog('Running latexmk...')
    const latexStart = Date.now()
    const cacheDir = join(projDir, 'build-cache')
    mkdirSync(buildDir, { recursive: true })

    try {
      // Copy source files into build dir
      cpSync(srcDir, buildDir, { recursive: true })

      // Seed with cached state from last successful build
      if (existsSync(cacheDir)) {
        cpSync(cacheDir, buildDir, { recursive: true })
      }

      // Generate stub PDFs from SVG figures so LaTeX draft mode gets correct dimensions.
      // The stub is a minimal PDF with just a MediaBox — no content, ~200 bytes.
      // This ensures the placeholder boxes match the SVGs that patch-svg-images.mjs injects.
      generateStubPdfs(buildDir, addLog)

      // Write latexmkrc for DVI+synctex mode
      writeFileSync(join(buildDir, '.latexmkrc'),
        `$latex = 'pdflatex --output-format=dvi -synctex=1 %O %P';\n`)

      // Image pipeline: SVG is the authoritative figure format.
      //   1. generateStubPdfs() creates minimal PDFs from SVG dimensions (above)
      //   2. latexmk runs in draft mode — reads stub PDFs for bounding boxes
      //   3. dvisvgm converts DVI → SVG pages with placeholder boxes
      //   4. patch-svg-images.mjs replaces placeholders with actual SVG content
      // The SVG dimensions drive the entire layout. No real PDFs needed.
      // Do NOT use dvipdfmx driver — it requires .xbb files, causing corrupt DVI.
      const pretex = '\\PassOptionsToPackage{draft}{graphicx}\\PassOptionsToPackage{hypertex,hidelinks}{hyperref}\\AddToHook{begindocument/before}{\\RequirePackage{hyperref}}'
      try {
        await run(
          `latexmk -dvi -f ` +
          `-interaction=nonstopmode ` +
          `-pretex='${pretex}' ` +
          `"${texBase}.tex"`,
          { cwd: buildDir, timeout: 120000 },
        )
      } catch (e) {
        // latexmk may exit non-zero due to warnings — check for DVI below
        addLog(`latexmk exited with warnings (continuing): ${e.message.split('\n')[0]}`)
      }
      addLog(`latexmk done in ${((Date.now() - latexStart) / 1000).toFixed(1)}s`)

      // Preserve the LaTeX log for error extraction (build dir gets cleaned up later)
      const latexLog = join(buildDir, `${texBase}.log`)
      if (existsSync(latexLog)) {
        cpSync(latexLog, join(projDir, 'latex.log'))
      }

      // Signal build errors (or clear previous ones) immediately after latexmk
      const { errors: logErrors, warnings: logWarnings } = extractBuildErrors(name)
      if (logErrors.length > 0) {
        addLog(`Found ${logErrors.length} error(s) in log — signaling immediately`)
        signalBuildStatus(name, `Build has errors`)
      } else {
        // Clear any previous errors
        signalBuildStatus(name, null)
      }
    } catch (e) {
      // Clean up build dir on failure
      try { rmSync(buildDir, { recursive: true, force: true }) } catch {}
      throw e
    }

    const dviFile = join(buildDir, `${texBase}.dvi`)
    if (!existsSync(dviFile)) throw new Error('DVI file not created')

    // All build output stages into buildDir, then gets atomically published
    // to outDir via copy-to-tmp + rename. The viewer never sees half-written
    // or missing files — each page is either fully old or fully new.
    const svgDir = join(buildDir, 'svg')
    mkdirSync(svgDir, { recursive: true })

    // Phase 2: SVG conversion
    status.phase = 'converting'

    // Load previous page hashes for change detection
    const hashesPath = join(outDir, 'page-hashes.json')
    let oldHashes = {}
    try { oldHashes = JSON.parse(readFileSync(hashesPath, 'utf8')) } catch {}

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
      // Patch priority pages in place
      try {
        await run(
          `node "${join(SCRIPTS_DIR, 'patch-svg-images.mjs')}" "${svgDir}" "${srcDir}"`,
          { cwd: PROJECT_ROOT, timeout: 60000 },
        )
      } catch {}
      // Hash-check and publish only changed priority pages
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
        signalReload(name, changedPriority)
        addLog(`Priority: ${changedPriority.length}/${priorityPages.length} pages changed`)
      } else {
        addLog(`Priority: 0/${priorityPages.length} pages changed, skipping reload`)
      }
    }

    // All pages: convert into svgDir (overwrites priority pages, that's fine)
    addLog('Converting all pages...')
    const svgStart = Date.now()
    await run(
      `dvisvgm --page=1- --font-format=woff2 --bbox=papersize --linkmark=none ` +
      `--output="${svgDir}/page-%p.svg" "${dviFile}"`,
      { cwd: srcDir, timeout: 120000 },
    )
    normalizeSvgNames(svgDir)
    addLog(`SVG conversion done in ${((Date.now() - svgStart) / 1000).toFixed(1)}s`)

    const allPageFiles = readdirSync(svgDir).filter(f => /^page-\d+\.svg$/.test(f))
    const pageCount = allPageFiles.length

    // Patch all image placeholders (fast, ~70ms — always patch everything)
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

    writeFileSync(hashesPath, JSON.stringify(newHashes, null, 2))
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

    // Phase 3: Extract macros (stage in buildDir, publish atomically)
    status.phase = 'extracting'
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

    // Phase 4: Synctex extraction
    const synctexFile = join(buildDir, `${texBase}.synctex.gz`)
    if (existsSync(synctexFile)) {
      addLog('Extracting synctex lookup...')
      const synctexStart = Date.now()
      try {
        await run(
          `node "${join(SCRIPTS_DIR, 'extract-synctex-lookup.mjs')}" "${join(buildDir, mainFile)}" "${join(buildDir, 'lookup.json')}"`,
          { cwd: PROJECT_ROOT, timeout: 600000 },
        )
        publishFile(join(buildDir, 'lookup.json'), join(outDir, 'lookup.json'))
        addLog(`Synctex done in ${((Date.now() - synctexStart) / 1000).toFixed(1)}s`)

        // Phase 5: Proof pairing (depends on lookup.json)
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
      } catch (e) {
        addLog(`Synctex extraction failed (non-fatal): ${e.message}`)
      }
    } else {
      addLog('No synctex.gz found, skipping lookup + proof pairing')
    }

    // Update project metadata
    updateProject(name, {
      pages: pageCount,
      buildStatus: 'success',
      lastBuild: new Date().toISOString(),
    })

    // Cache build state for next incremental build
    const CACHE_EXTS = /\.(aux|bbl|toc|out|synctex\.gz)$/
    try {
      mkdirSync(cacheDir, { recursive: true })
      for (const f of readdirSync(buildDir)) {
        if (CACHE_EXTS.test(f)) cpSync(join(buildDir, f), join(cacheDir, f))
      }
    } catch (e) {
      addLog(`Cache save failed (non-fatal): ${e.message}`)
    }

    const totalElapsed = ((Date.now() - new Date(status.startedAt).getTime()) / 1000).toFixed(1)
    addLog(`Build complete in ${totalElapsed}s`)

    status.building = false
    status.phase = 'done'
    status.completedAt = new Date().toISOString()

    // Write build log
    writeFileSync(join(projDir, 'build.log'), log.join('\n'))

    return status
  } catch (e) {
    addLog(`BUILD FAILED: ${e.message}`)
    status.building = false
    status.phase = 'failed'
    status.error = e.message

    try { updateProject(name, { buildStatus: 'failed' }) } catch {}
    try { writeFileSync(join(projDir, 'build.log'), log.join('\n')) } catch {}

    // Signal viewers about the failure so they can surface errors
    signalBuildStatus(name, e.message)

    throw e
  } finally {
    buildChildProcesses.delete(buildId)
    // Clean up temp build directory
    try { rmSync(buildDir, { recursive: true, force: true }) } catch {}
  }
}

function signalBuildStatus(name, errorMessage) {
  try {
    const roomId = `doc-${name}`
    const doc = getDoc(roomId)
    const yRecords = doc.getMap('tldraw')

    // Extract structured errors from the LaTeX log
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

