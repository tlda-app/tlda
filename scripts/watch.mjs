#!/usr/bin/env node
/**
 * File watcher for auto-rebuild.
 *
 * Watches .tex/.bib/.sty files and does incremental rebuilds:
 *   1. Precompiled preamble (.fmt via mylatexformat) — built once on startup,
 *      rebuilt when preamble changes. Body-only .tex edits use fast single-pass
 *      pdflatex with the format; .bib/.sty/.cls changes fall back to latexmk.
 *   2. dvisvgm for visible pages first → partial reload (seconds)
 *   3. dvisvgm for remaining pages → full reload (background)
 *   4. synctex extraction on long debounce
 *
 * Usage:
 *   node scripts/watch.mjs /path/to/main.tex doc-name ["Document Title"]
 *
 * Environment:
 *   SYNC_SERVER  - Yjs sync server URL (default: ws://localhost:5176)
 *   DEBOUNCE_MS  - Rebuild debounce in ms (default: 2000)
 */

import { watch, existsSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { execSync, spawn } from 'child_process'
import { dirname, resolve, basename, join } from 'path'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import * as Y from 'yjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

const args = process.argv.slice(2)
const TEX_FILE = args.find(a => !a.startsWith('--'))
if (!TEX_FILE) {
  console.error('Usage: node scripts/watch.mjs <tex-file> [doc-name] ["Document Title"]')
  process.exit(1)
}

const positional = args.filter(a => !a.startsWith('--'))
const DOC_NAME = positional[1] || basename(TEX_FILE, '.tex')
const DOC_TITLE = positional[2] || DOC_NAME
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

// Detect page count from existing SVGs or manifest
function detectPageCount() {
  try {
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'public', 'docs', 'manifest.json'), 'utf8'))
    if (manifest.documents?.[DOC_NAME]?.pages) {
      return manifest.documents[DOC_NAME].pages
    }
  } catch {}
  // Count existing SVG files
  let n = 0
  while (existsSync(join(OUTPUT_DIR, `page-${String(n + 1).padStart(2, '0')}.svg`))) n++
  return n
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
      doBuild()
    }
  }, DEBOUNCE_MS)
}

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

    // Update manifest
    try {
      execSync(
        `node -e "
const fs = require('fs');
const p = '${join(PROJECT_ROOT, 'public', 'docs', 'manifest.json')}';
const m = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {documents:{}};
m.documents['${DOC_NAME}'] = { name: '${DOC_TITLE}', pages: ${totalPages || 47}, basePath: '/docs/${DOC_NAME}/' };
fs.writeFileSync(p, JSON.stringify(m, null, 2));
"`,
        { cwd: PROJECT_ROOT, stdio: 'pipe' }
      )
    } catch {}

    // Full reload signal
    signalReload(null)

    // Schedule synctex extraction
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
      } else if (code !== null) {
        console.error(`[watch] Synctex extraction failed (code ${code})`)
      }
    })
  }, SYNCTEX_DEBOUNCE_MS)
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

// Watch the tex directory
const WATCH_EXTENSIONS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.def'])

console.log(`[watch] Watching ${texDir}`)
console.log(`[watch] Doc: ${DOC_NAME}, Tex: ${texPath}`)
console.log(`[watch] Sync server: ${SYNC_URL}`)
console.log(`[watch] Synctex debounce: ${SYNCTEX_DEBOUNCE_MS / 1000}s`)
console.log(`[watch] Debounce: ${DEBOUNCE_MS}ms`)
console.log()

watch(texDir, { recursive: true }, (_eventType, filename) => {
  if (!filename) return
  if (filename.includes('.aux') || filename.includes('.log') || filename.includes('.out') ||
      filename.includes('.synctex') || filename.includes('.fls') || filename.includes('.fdb') ||
      filename.includes('.bbl') || filename.includes('.blg') || filename.includes('.bcf') ||
      filename.includes('.run.xml') || filename.includes('.toc') || filename.includes('.lof') ||
      filename.includes('.lot') || filename.includes('.nav') || filename.includes('.snm') ||
      filename.includes('.vrb') || filename.includes('.dvi') || filename.includes('.pdf') ||
      filename.includes('.fmt') || filename.includes('_fmt.')) {
    return
  }
  const ext = '.' + filename.split('.').pop()
  if (!WATCH_EXTENSIONS.has(ext)) return

  console.log(`[watch] Changed: ${filename}`)
  const isTex = filename.endsWith('.tex')
  triggerBuild(!isTex) // .bib/.sty/.cls → full rebuild with latexmk
})

// Build format file on startup
ensureFormat()

// Do an initial build on startup
totalPages = detectPageCount()
if (totalPages > 0) {
  console.log(`[watch] Existing doc has ${totalPages} pages, skipping initial build`)
  console.log('[watch] Waiting for changes...')
} else {
  console.log('[watch] No existing pages, running initial build...')
  needFullRebuild = true // first build always full
  doBuild()
}
