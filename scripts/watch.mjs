#!/usr/bin/env node
/**
 * File watcher for auto-rebuild.
 *
 * Supports both TeX and Quarto/HTML sources:
 *
 * TeX (.tex):
 *   Watches .tex/.bib/.sty files and does incremental rebuilds:
 *   1. Precompiled preamble (.fmt via mylatexformat) — built once on startup,
 *      rebuilt when preamble changes. Body-only .tex edits use fast single-pass
 *      pdflatex with the format; .bib/.sty/.cls changes fall back to latexmk.
 *   2. dvisvgm for visible pages first → partial reload (seconds)
 *   3. dvisvgm for remaining pages → full reload (background)
 *   4. synctex extraction on long debounce
 *
 * Quarto/HTML (.qmd, .html):
 *   Watches .qmd/.html/.R/.py/.css/.scss files and rebuilds via build-html-doc.mjs.
 *   Simpler pipeline — single command, full reload on every change.
 *
 * Usage:
 *   node scripts/watch.mjs /path/to/main.tex doc-name ["Document Title"]
 *   node scripts/watch.mjs /path/to/lecture.qmd doc-name ["Document Title"]
 *
 * Environment:
 *   SYNC_SERVER  - Yjs sync server URL (default: ws://localhost:5176)
 *   DEBOUNCE_MS  - Rebuild debounce in ms (default: 2000)
 */

import { watch, existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs'
import { createHash } from 'crypto'
import { execSync, spawn } from 'child_process'
import { dirname, resolve, basename, join } from 'path'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import * as Y from 'yjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

const args = process.argv.slice(2)
const SOURCE_FILE = args.find(a => !a.startsWith('--'))
if (!SOURCE_FILE) {
  console.error('Usage: node scripts/watch.mjs <tex-or-qmd-file> [doc-name] ["Document Title"]')
  process.exit(1)
}

const positional = args.filter(a => !a.startsWith('--'))
const sourceExt = SOURCE_FILE.split('.').pop().toLowerCase()
const IS_HTML_MODE = sourceExt === 'qmd' || sourceExt === 'html'
const DOC_NAME = positional[1] || basename(SOURCE_FILE, '.' + sourceExt)
const DOC_TITLE = positional[2] || DOC_NAME
// Keep TEX_FILE alias for TeX-mode code paths
const TEX_FILE = SOURCE_FILE
const SYNC_URL = process.env.SYNC_SERVER || 'ws://localhost:5176'
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '200', 10)
const SYNCTEX_DEBOUNCE_MS = parseInt(process.env.SYNCTEX_DEBOUNCE_MS || '30000', 10)

let synctexTimeout = null
let synctexStale = false

const texPath = resolve(TEX_FILE)
const texDir = dirname(texPath)
const texBase = basename(texPath, '.tex')
const OUTPUT_DIR = join(PROJECT_ROOT, 'public', 'docs', DOC_NAME)

let buildTimeout = null
let isBuilding = false
let buildQueued = false
let totalPages = 0
let bgChild = null // background dvisvgm process (interruptible)

// ---- Precompiled preamble (format file) ----

const fmtName = `${texBase}_fmt`
const fmtPath = join(texDir, `${fmtName}.fmt`)
const fmtHashPath = join(texDir, `${fmtName}.hash`)
let fmtAvailable = false

function getPreambleHash() {
  try {
    const content = readFileSync(texPath, 'utf8')
    const idx = content.indexOf('\\begin{document}')
    if (idx === -1) return null
    const preamble = content.slice(0, idx)
    return createHash('md5').update(preamble).digest('hex')
  } catch { return null }
}

function ensureFormat() {
  const hash = getPreambleHash()
  if (!hash) { fmtAvailable = false; return }

  // Check if existing format matches
  if (existsSync(fmtPath) && existsSync(fmtHashPath)) {
    const saved = readFileSync(fmtHashPath, 'utf8').trim()
    if (saved === hash) { fmtAvailable = true; return }
  }

  // Build format file
  const start = Date.now()
  console.log('[watch] Building format file (preamble precompilation)...')
  try {
    execSync(
      `pdflatex -ini -jobname="${fmtName}" "&pdflatex" mylatexformat.ltx "${texBase}.tex"`,
      { cwd: texDir, stdio: 'pipe' }
    )
    writeFileSync(fmtHashPath, hash)
    fmtAvailable = true
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`[watch] Format file ready in ${elapsed}s`)
  } catch (e) {
    console.error(`[watch] Format build failed: ${e.message}`)
    fmtAvailable = false
  }
}

// Detect page count — always count files on disk (source of truth), manifest as fallback
import { getDoc, listDocs } from './manifest.mjs'
function detectPageCount() {
  const ext = IS_HTML_MODE ? 'html' : 'svg'
  let n = 0
  while (existsSync(join(OUTPUT_DIR, `page-${String(n + 1).padStart(2, '0')}.${ext}`))) n++
  if (n > 0) return n
  // No files yet — check manifest for initial count
  return getDoc(DOC_NAME)?.pages || 0
}

// ---- Persistent Yjs connection (for viewport reads + reload signals) ----

const ROOM_ID = `doc-${DOC_NAME}`
const yjsDoc = new Y.Doc()
const yRecords = yjsDoc.getMap('tldraw')
let yjsWs = null
let yjsSynced = false
let cachedViewportPages = null

// Reactively cache visible pages from viewer's viewport broadcasts
yRecords.observe((event) => {
  event.changes.keys.forEach((change, key) => {
    if (key === 'signal:viewport' && (change.action === 'add' || change.action === 'update')) {
      const viewport = yRecords.get(key)
      if (viewport?.pages) {
        cachedViewportPages = viewport.pages
      }
    }
    if (key === 'signal:reverse-sync' && (change.action === 'add' || change.action === 'update')) {
      const sig = yRecords.get(key)
      if (sig?.line) {
        const target = `${texPath}:${sig.line}`
        console.log(`[reverse-sync] Opening ${target}`)
        spawn('zed', [target], { stdio: 'ignore', detached: true }).unref()
      }
    }
  })
})

// Forward local doc updates to server via persistent connection
yjsDoc.on('update', (update, origin) => {
  if (origin === 'remote') return
  if (yjsWs?.readyState === WebSocket.OPEN) {
    yjsWs.send(JSON.stringify({ type: 'update', data: Array.from(update) }))
  }
})

function connectYjs() {
  yjsSynced = false
  const ws = new WebSocket(`${SYNC_URL}/${ROOM_ID}`)
  yjsWs = ws

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'sync') {
        Y.applyUpdate(yjsDoc, new Uint8Array(msg.data), 'remote')
        yjsSynced = true
        // Seed cached viewport from initial sync
        const viewport = yRecords.get('signal:viewport')
        if (viewport?.pages) cachedViewportPages = viewport.pages
      } else if (msg.type === 'update') {
        Y.applyUpdate(yjsDoc, new Uint8Array(msg.data), 'remote')
      }
    } catch {}
  })

  ws.on('close', () => {
    yjsSynced = false
    yjsWs = null
    setTimeout(connectYjs, 2000)
  })

  ws.on('error', () => {}) // onclose fires after
}

connectYjs()

function getVisiblePages() {
  return cachedViewportPages
}

let needFullRebuild = false // set when .bib/.sty/.cls changes or preamble changes

function triggerBuild(full = false) {
  if (full) needFullRebuild = true
  if (buildTimeout) clearTimeout(buildTimeout)
  buildTimeout = setTimeout(() => {
    // Kill background conversion — new build supersedes it
    if (bgChild) {
      bgChild.kill()
      bgChild = null
    }
    if (isBuilding) {
      buildQueued = true
    } else {
      IS_HTML_MODE ? doHtmlBuild() : doBuild()
    }
  }, DEBOUNCE_MS)
}

// ---- HTML/Quarto build path ----

async function doHtmlBuild() {
  isBuilding = true
  buildQueued = false
  const start = Date.now()
  console.log(`\n[watch] Rebuilding ${DOC_NAME} (HTML)...`)

  try {
    execSync(
      `node scripts/build-html-doc.mjs "${texPath}" "${DOC_NAME}" "${DOC_TITLE}"`,
      { cwd: PROJECT_ROOT, stdio: 'inherit' }
    )
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`[watch] HTML build done in ${elapsed}s`)

    // Signal full reload
    signalReload(null)
  } catch (e) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.error(`[watch] HTML build failed in ${elapsed}s: ${e.message}`)
  }

  isBuilding = false
  if (buildQueued) {
    console.log('[watch] Changes detected during build, rebuilding...')
    doHtmlBuild()
  }
}

// ---- TeX build path ----

async function doBuild() {
  isBuilding = true
  buildQueued = false
  const full = needFullRebuild
  needFullRebuild = false
  const start = Date.now()
  console.log(`\n[watch] Rebuilding ${DOC_NAME}${full ? ' (full)' : ''}...`)

  try {
    // Check if preamble changed → rebuild format
    const oldHash = existsSync(fmtHashPath) ? readFileSync(fmtHashPath, 'utf8').trim() : null
    const newHash = getPreambleHash()
    const preambleChanged = newHash && newHash !== oldHash

    if (preambleChanged) {
      ensureFormat()
    }

    // Step 1: compile
    const latexStart = Date.now()
    let usedFmt = false
    if (!full && fmtAvailable) {
      // Fast path: single pdflatex pass with precompiled preamble
      console.log('[watch] Running pdflatex (format)...')
      try {
        execSync(
          `pdflatex -fmt="./${fmtName}" --output-format=dvi -synctex=1 -interaction=batchmode "${texBase}.tex"`,
          { cwd: texDir, stdio: 'pipe' }
        )
        usedFmt = true
        // Check log for undefined refs/citations → schedule full rebuild
        const logPath = join(texDir, `${texBase}.log`)
        if (existsSync(logPath)) {
          const log = readFileSync(logPath, 'utf8')
          if (/undefined references|Citation .* undefined|Please rerun|No file .+\.bbl/i.test(log)) {
            console.log('[watch] Undefined refs detected after fast build, scheduling full rebuild...')
            needFullRebuild = true
          }
        }
      } catch {
        console.log('[watch] Format build failed, falling back to latexmk...')
      }
    }
    if (!usedFmt) {
      // Full path: latexmk handles biber, multiple passes, etc.
      console.log('[watch] Running latexmk...')
      execSync(
        `latexmk -dvi -latex="pdflatex --output-format=dvi -synctex=1 %O %S" -interaction=batchmode "${texBase}.tex"`,
        { cwd: texDir, stdio: 'pipe' }
      )
      // Rebuild format after full latexmk if we don't have one yet
      if (!fmtAvailable) ensureFormat()
    }
    const latexElapsed = ((Date.now() - latexStart) / 1000).toFixed(1)
    console.log(`[watch] ${usedFmt ? 'pdflatex (fmt)' : 'latexmk'} done in ${latexElapsed}s`)

    const dviFile = join(texDir, `${texBase}.dvi`)
    if (!existsSync(dviFile)) {
      throw new Error('DVI file not created')
    }

    // Step 2: Get visible pages for priority rebuild (cached from persistent Yjs connection)
    const visiblePages = getVisiblePages()
    const priorityPages = visiblePages || [1] // default to page 1

    // Step 3: dvisvgm for priority pages first
    if (priorityPages.length > 0) {
      const pageSpec = priorityPages.join(',')
      const svgStart = Date.now()
      console.log(`[watch] Converting priority pages [${pageSpec}]...`)
      execSync(
        `dvisvgm --page=${pageSpec} --font-format=woff2 --bbox=papersize --output="${OUTPUT_DIR}/page-%p.svg" "${dviFile}"`,
        { cwd: texDir, stdio: 'pipe' }
      )
      const svgElapsed = ((Date.now() - svgStart) / 1000).toFixed(1)
      console.log(`[watch] Priority pages done in ${svgElapsed}s`)

      // Partial reload — viewers update these pages immediately
      signalReload(priorityPages)
    }

    // Step 4: Extract macros (fast, always do it)
    try {
      execSync(
        `node scripts/extract-preamble.js "${texPath}" "${OUTPUT_DIR}/macros.json"`,
        { cwd: PROJECT_ROOT, stdio: 'pipe' }
      )
    } catch {}

    const criticalElapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`[watch] Critical path done in ${criticalElapsed}s`)

  } catch (e) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.error(`[watch] Build failed in ${elapsed}s: ${e.message}`)
  }

  // Critical path done — release the build lock so new saves aren't blocked
  isBuilding = false

  if (buildQueued) {
    console.log('[watch] Changes detected during build, rebuilding...')
    doBuild()
    return // skip background work — new build supersedes
  }

  // Step 5: background all-pages dvisvgm (interruptible)
  const dviFile = join(texDir, `${texBase}.dvi`)
  if (existsSync(dviFile)) {
    startBackgroundConversion(dviFile, start)
  }
}

function startBackgroundConversion(dviFile, buildStart) {
  // Kill any previous background conversion
  if (bgChild) {
    bgChild.kill()
    bgChild = null
  }

  const allStart = Date.now()
  console.log('[watch] Converting all pages (background)...')

  const child = spawn('dvisvgm', [
    '--page=1-', '--font-format=woff2', '--bbox=papersize',
    `--output=${OUTPUT_DIR}/page-%p.svg`, dviFile
  ], { cwd: texDir, stdio: 'pipe' })

  bgChild = child

  child.on('close', (code) => {
    if (bgChild !== child) return // superseded by newer conversion
    bgChild = null

    if (code !== 0) {
      if (code === null) {
        console.log('[watch] Background conversion interrupted')
      } else {
        console.error(`[watch] Background dvisvgm exited with code ${code}`)
      }
      return
    }

    const allElapsed = ((Date.now() - allStart) / 1000).toFixed(1)
    totalPages = detectPageCount()
    console.log(`[watch] All ${totalPages} pages done in ${allElapsed}s`)

    // Update manifest via shared module
    try {
      execSync(
        `node scripts/manifest.mjs set '${DOC_NAME}' --name '${DOC_TITLE}' --pages ${totalPages}`,
        { cwd: PROJECT_ROOT, stdio: 'pipe' }
      )
    } catch {}

    // Full reload signal
    signalReload(null)

    // Rebuild diff doc immediately with existing lookup (synctex may be delayed)
    rebuildDiffDoc()

    // Schedule synctex extraction (will rebuild diff again with updated lookup)
    scheduleSynctex()

    const totalElapsed = ((Date.now() - buildStart) / 1000).toFixed(1)
    console.log(`[watch] Build complete in ${totalElapsed}s`)
  })
}

let synctexChild = null

function scheduleSynctex() {
  if (!existsSync(join(texDir, `${texBase}.synctex.gz`))) return
  synctexStale = true
  if (synctexTimeout) clearTimeout(synctexTimeout)
  synctexTimeout = setTimeout(() => {
    if (!synctexStale) return
    if (isBuilding) { scheduleSynctex(); return } // wait for build to finish
    synctexStale = false

    // Kill previous extraction if still running
    if (synctexChild) {
      synctexChild.kill()
      synctexChild = null
    }

    const start = Date.now()
    console.log(`[watch] Extracting synctex lookup (background)...`)

    const child = spawn('node', [
      'scripts/extract-synctex-lookup.mjs', texPath, `${OUTPUT_DIR}/lookup.json`
    ], { cwd: PROJECT_ROOT, stdio: 'pipe' })

    synctexChild = child

    child.on('close', (code) => {
      if (synctexChild !== child) return // superseded
      synctexChild = null
      if (code === 0) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1)
        console.log(`[watch] Synctex extraction done in ${elapsed}s`)
        // Rebuild dependent diff doc (needs updated lookup.json)
        rebuildDiffDoc()
        // Rebuild proof pairing (needs updated lookup.json)
        rebuildProofPairing()
      } else if (code !== null) {
        console.error(`[watch] Synctex extraction failed (code ${code})`)
      }
    })
  }, SYNCTEX_DEBOUNCE_MS)
}

// ---- Diff doc rebuild (if a diff doc depends on this doc) ----

let diffDocName = null
let diffDocInfo = null

function detectDiffDoc() {
  try {
    const docs = listDocs()
    for (const [name, info] of Object.entries(docs)) {
      if (info.format === 'diff' && info.sourceDoc === DOC_NAME) {
        diffDocName = name
        diffDocInfo = info
        console.log(`[watch] Found dependent diff doc: ${name}`)
        return
      }
    }
  } catch {}
}

function rebuildDiffDoc() {
  if (!diffDocName || !diffDocInfo) return
  const diffDir = join(PROJECT_ROOT, 'public', 'docs', diffDocName)
  if (!existsSync(diffDir)) return

  const diffStart = Date.now()
  console.log(`[watch] Rebuilding diff doc ${diffDocName}...`)

  try {
    // Copy current SVGs to diff output dir
    for (let i = 1; i <= totalPages; i++) {
      const f = `page-${String(i).padStart(2, '0')}.svg`
      const src = join(OUTPUT_DIR, f)
      const dst = join(diffDir, f)
      if (existsSync(src)) copyFileSync(src, dst)
    }

    // Copy current lookup.json
    const lookupSrc = join(OUTPUT_DIR, 'lookup.json')
    const lookupDst = join(diffDir, 'lookup.json')
    if (existsSync(lookupSrc)) copyFileSync(lookupSrc, lookupDst)

    // Copy macros.json
    const macrosSrc = join(OUTPUT_DIR, 'macros.json')
    const macrosDst = join(diffDir, 'macros.json')
    if (existsSync(macrosSrc)) copyFileSync(macrosSrc, macrosDst)

    // Count old pages
    let oldPageCount = 0
    while (existsSync(join(diffDir, `old-page-${oldPageCount + 1}.svg`))) oldPageCount++

    // Extract git ref from diff-info.json
    let gitRef = 'HEAD~1'
    try {
      const diffInfo = JSON.parse(readFileSync(join(diffDir, 'diff-info.json'), 'utf8'))
      gitRef = diffInfo.meta?.gitRef || 'HEAD~1'
    } catch {}

    // Re-run diff pairing
    execSync(
      `node scripts/compute-diff-pairing.mjs "${texDir}" "${texBase}.tex" "${gitRef}" "${lookupDst}" "${join(diffDir, 'old-lookup.json')}" "${join(diffDir, 'diff-info.json')}" "${totalPages}" "${oldPageCount}"`,
      { cwd: PROJECT_ROOT, stdio: 'pipe' }
    )

    // Signal reload on diff doc's Yjs room
    const diffRoomId = `doc-${diffDocName}`
    const diffSignal = { type: 'full', timestamp: Date.now() }
    // Write to a temporary Y.Doc for the diff room
    const diffYDoc = new Y.Doc()
    const diffYRecords = diffYDoc.getMap('tldraw')
    const diffWs = new WebSocket(`${SYNC_URL}/${diffRoomId}`)
    diffWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'sync' || msg.type === 'update') {
          Y.applyUpdate(diffYDoc, new Uint8Array(msg.data), 'remote')
        }
      } catch {}
    })
    diffWs.on('open', () => {
      setTimeout(() => {
        diffYDoc.transact(() => {
          diffYRecords.set('signal:reload', diffSignal)
        })
        console.log(`[watch] Diff reload signal sent to ${diffRoomId}`)
        setTimeout(() => diffWs.close(), 500)
      }, 500)
    })
    diffWs.on('error', () => {})

    const elapsed = ((Date.now() - diffStart) / 1000).toFixed(1)
    console.log(`[watch] Diff doc rebuilt in ${elapsed}s`)
  } catch (e) {
    console.error(`[watch] Diff rebuild failed: ${e.message}`)
  }
}

function rebuildProofPairing() {
  const lookupFile = join(OUTPUT_DIR, 'lookup.json')
  if (!existsSync(lookupFile)) return

  const start = Date.now()
  try {
    execSync(
      `node scripts/compute-proof-pairing.mjs "${texPath}" "${lookupFile}" "${join(OUTPUT_DIR, 'proof-info.json')}"`,
      { cwd: PROJECT_ROOT, stdio: 'pipe' }
    )
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`[watch] Proof pairing rebuilt in ${elapsed}s`)
  } catch (e) {
    console.error(`[watch] Proof pairing failed: ${e.message}`)
  }
}

function signalReload(pages) {
  const signal = pages
    ? { type: 'partial', pages, timestamp: Date.now() }
    : { type: 'full', timestamp: Date.now() }

  yjsDoc.transact(() => {
    yRecords.set('signal:reload', signal)
  })

  const desc = pages ? `pages [${pages.join(',')}]` : 'full'
  console.log(`[watch] Reload signal (${desc}) sent to ${ROOM_ID}`)
}

// Watch the source directory
const TEX_EXTENSIONS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.def'])
const HTML_EXTENSIONS = new Set(['.qmd', '.html', '.css', '.scss', '.R', '.py', '.js', '.lua'])
const WATCH_EXTENSIONS = IS_HTML_MODE ? HTML_EXTENSIONS : TEX_EXTENSIONS

const TEX_JUNK = ['.aux', '.log', '.out', '.synctex', '.fls', '.fdb', '.bbl', '.blg',
  '.bcf', '.run.xml', '.toc', '.lof', '.lot', '.nav', '.snm', '.vrb', '.dvi', '.pdf', '.fmt', '_fmt.']

console.log(`[watch] Watching ${texDir}`)
console.log(`[watch] Mode: ${IS_HTML_MODE ? 'HTML/Quarto' : 'TeX'}`)
console.log(`[watch] Doc: ${DOC_NAME}, Source: ${texPath}`)
console.log(`[watch] Sync server: ${SYNC_URL}`)
if (!IS_HTML_MODE) console.log(`[watch] Synctex debounce: ${SYNCTEX_DEBOUNCE_MS / 1000}s`)
console.log(`[watch] Debounce: ${DEBOUNCE_MS}ms`)
console.log()

watch(texDir, { recursive: true }, (_eventType, filename) => {
  if (!filename) return
  // Skip build artifacts
  if (!IS_HTML_MODE && TEX_JUNK.some(j => filename.includes(j))) return
  // Skip node_modules, _site, _book, .git
  if (filename.includes('node_modules') || filename.includes('_site') ||
      filename.includes('_book') || filename.includes('.git')) return

  const ext = '.' + filename.split('.').pop()
  if (!WATCH_EXTENSIONS.has(ext)) return

  console.log(`[watch] Changed: ${filename}`)
  if (IS_HTML_MODE) {
    triggerBuild() // HTML mode: always full rebuild
  } else {
    const isTex = filename.endsWith('.tex')
    triggerBuild(!isTex) // .bib/.sty/.cls → full rebuild with latexmk
  }
})

// Detect dependent diff docs on startup
if (!IS_HTML_MODE) detectDiffDoc()

if (IS_HTML_MODE) {
  // HTML mode: simpler startup
  totalPages = detectPageCount()
  if (totalPages > 0) {
    console.log(`[watch] Existing doc has ${totalPages} pages, skipping initial build`)
    console.log('[watch] Waiting for changes...')
  } else {
    console.log('[watch] No existing pages, running initial build...')
    doHtmlBuild()
  }
} else {
  // TeX mode: build format file on startup
  ensureFormat()

  totalPages = detectPageCount()
  if (totalPages > 0) {
    console.log(`[watch] Existing doc has ${totalPages} pages, skipping initial build`)
    console.log('[watch] Waiting for changes...')
  } else {
    console.log('[watch] No existing pages, running initial build...')
    needFullRebuild = true // first build always full
    doBuild()
  }
}
