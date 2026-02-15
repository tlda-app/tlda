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
const execAsync = (cmd, opts = {}) => _execAsync(cmd, { maxBuffer: 50 * 1024 * 1024, ...opts })
import { existsSync, readdirSync, writeFileSync, readFileSync, unlinkSync, renameSync } from 'fs'
import { join, basename, dirname } from 'path'
import { fileURLToPath } from 'url'
import { updateProject, sourceDir, outputDir, projectDir, readProject, listProjects } from './project-store.mjs'
import { getDoc } from './yjs-sync.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..', '..')
const SCRIPTS_DIR = join(PROJECT_ROOT, 'scripts')

/** Strip leading zeros from dvisvgm page numbers: page-01.svg → page-1.svg */
function normalizeSvgNames(dir) {
  for (const f of readdirSync(dir)) {
    const m = f.match(/^page-0+(\d+\.svg)$/)
    if (m) renameSync(join(dir, f), join(dir, `page-${m[1]}`))
  }
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

// Abort controllers for cancelling in-progress builds
const buildAbortControllers = new Map()

export async function runBuild(name, { priorityPages } = {}) {
  // If a build is already running, kill it and restart
  const existing = activeBuilds.get(name)
  if (existing?.building) {
    console.log(`[build:${name}] Killing stale build, restarting`)
    const ac = buildAbortControllers.get(name)
    if (ac) ac.abort()
    // Wait briefly for cleanup
    await new Promise(r => setTimeout(r, 500))
  }

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

  const ac = new AbortController()
  buildAbortControllers.set(name, ac)
  const { signal } = ac

  const log = []
  const status = {
    building: true,
    startedAt: new Date().toISOString(),
    phase: 'compiling',
    log,
  }
  activeBuilds.set(name, status)

  const run = (cmd, opts = {}) => execAsync(cmd, { signal, ...opts })

  const addLog = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`
    log.push(line)
    console.log(`[build:${name}] ${msg}`)
  }

  try {
    updateProject(name, { buildStatus: 'building', lastBuild: status.startedAt })

    // Clean stale build artifacts so latexmk does a fresh compile with synctex.
    // Use -dvi to match our build mode (user's latexmkrc might default to -pdf).
    try {
      await run(`latexmk -C -dvi "${texBase}.tex"`, { cwd: srcDir, timeout: 10000 })
    } catch {
      // latexmk -C may fail if no prior build — that's fine
    }

    // Phase 1: LaTeX compilation
    // latexmk -f continues through errors; check for DVI rather than exit code
    addLog('Running latexmk...')
    const latexStart = Date.now()

    // Write a project-level latexmkrc to ensure DVI+synctex mode with pretex.
    // We can't use -usepretex because it resets $latex to 'latex %O %P',
    // overriding our pdflatex+synctex command. Instead, embed %P directly
    // in the $latex definition so pretex code gets injected.
    const projectRc = join(srcDir, '.latexmkrc')
    writeFileSync(projectRc, `$latex = 'pdflatex --output-format=dvi -synctex=1 %O %P';\n`)

    const pretex = '\\PassOptionsToPackage{draft,dvipdfmx}{graphicx}\\PassOptionsToPackage{hypertex,hidelinks}{hyperref}\\AddToHook{begindocument/before}{\\RequirePackage{hyperref}}'
    try {
      await run(
        `latexmk -dvi -f ` +
        `-interaction=nonstopmode ` +
        `-pretex='${pretex}' ` +
        `"${texBase}.tex"`,
        { cwd: srcDir, timeout: 120000 },
      )
    } catch (e) {
      // latexmk may exit non-zero due to warnings — check for DVI below
      addLog(`latexmk exited with warnings (continuing): ${e.message.split('\n')[0]}`)
    }
    addLog(`latexmk done in ${((Date.now() - latexStart) / 1000).toFixed(1)}s`)

    const dviFile = join(srcDir, `${texBase}.dvi`)
    if (!existsSync(dviFile)) throw new Error('DVI file not created')

    // Phase 2: SVG conversion
    status.phase = 'converting'

    // Clean old page SVGs before generating new ones
    for (const f of readdirSync(outDir)) {
      if (/^page-\d+\.svg$/.test(f)) unlinkSync(join(outDir, f))
    }

    // Priority pages first
    if (priorityPages?.length > 0) {
      const pageSpec = priorityPages.join(',')
      addLog(`Converting priority pages [${pageSpec}]...`)
      await run(
        `dvisvgm --page=${pageSpec} --font-format=woff2 --bbox=papersize --linkmark=none ` +
        `--output="${outDir}/page-%p.svg" "${dviFile}"`,
        { cwd: srcDir },
      )
      // Normalize zero-padded names (dvisvgm 3.x pads page numbers)
      normalizeSvgNames(outDir)
      signalReload(name, priorityPages)
    }

    // All pages
    addLog('Converting all pages...')
    const svgStart = Date.now()
    await run(
      `dvisvgm --page=1- --font-format=woff2 --bbox=papersize --linkmark=none ` +
      `--output="${outDir}/page-%p.svg" "${dviFile}"`,
      { cwd: srcDir, timeout: 120000 },
    )
    // Normalize zero-padded names (dvisvgm 3.x pads page numbers)
    normalizeSvgNames(outDir)
    addLog(`SVG conversion done in ${((Date.now() - svgStart) / 1000).toFixed(1)}s`)

    // Phase 2b: Patch draft-mode image placeholders with actual images
    addLog('Patching image placeholders...')
    try {
      const { stdout: patchStdout } = await run(
        `node "${join(SCRIPTS_DIR, 'patch-svg-images.mjs')}" "${outDir}" "${srcDir}"`,
        { cwd: PROJECT_ROOT, timeout: 60000 },
      )
      const patchOutput = (patchStdout || '').trim()
      if (patchOutput) addLog(patchOutput.split('\n').pop())
    } catch (e) {
      addLog(`Image patching failed (non-fatal): ${e.message.split('\n')[0]}`)
    }

    // Count pages
    const pageCount = readdirSync(outDir).filter(f => /^page-\d+\.svg$/.test(f)).length
    addLog(`Generated ${pageCount} pages`)

    // Signal full reload after all pages
    signalReload(name, null)

    // Phase 3: Extract macros
    status.phase = 'extracting'
    addLog('Extracting preamble macros...')
    try {
      await run(
        `node "${join(SCRIPTS_DIR, 'extract-preamble.js')}" "${texPath}" "${join(outDir, 'macros.json')}"`,
        { cwd: PROJECT_ROOT },
      )
    } catch (e) {
      addLog(`Macro extraction failed (non-fatal): ${e.message}`)
    }

    // Phase 4: Synctex extraction
    const synctexFile = join(srcDir, `${texBase}.synctex.gz`)
    if (existsSync(synctexFile)) {
      addLog('Extracting synctex lookup...')
      const synctexStart = Date.now()
      try {
        await run(
          `node "${join(SCRIPTS_DIR, 'extract-synctex-lookup.mjs')}" "${texPath}" "${join(outDir, 'lookup.json')}"`,
          { cwd: PROJECT_ROOT, timeout: 600000 },
        )
        addLog(`Synctex done in ${((Date.now() - synctexStart) / 1000).toFixed(1)}s`)

        // Phase 5: Proof pairing (depends on lookup.json)
        addLog('Computing proof pairing...')
        try {
          await run(
            `node "${join(SCRIPTS_DIR, 'compute-proof-pairing.mjs')}" "${texPath}" ` +
            `"${join(outDir, 'lookup.json')}" "${join(outDir, 'proof-info.json')}"`,
            { cwd: PROJECT_ROOT, timeout: 120000 },
          )
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

    const totalElapsed = ((Date.now() - new Date(status.startedAt).getTime()) / 1000).toFixed(1)
    addLog(`Build complete in ${totalElapsed}s`)

    status.building = false
    status.phase = 'done'
    status.completedAt = new Date().toISOString()

    // Write build log
    writeFileSync(join(projDir, 'build.log'), log.join('\n'))

    return status
  } catch (e) {
    if (signal.aborted) {
      addLog('Build cancelled (newer build requested)')
      status.building = false
      status.phase = 'cancelled'
      return status
    }
    addLog(`BUILD FAILED: ${e.message}`)
    status.building = false
    status.phase = 'failed'
    status.error = e.message

    try { updateProject(name, { buildStatus: 'failed' }) } catch {}
    try { writeFileSync(join(projDir, 'build.log'), log.join('\n')) } catch {}

    throw e
  } finally {
    buildAbortControllers.delete(name)
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
