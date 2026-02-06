#!/usr/bin/env node
/**
 * File watcher for auto-rebuild.
 *
 * Watches .tex/.bib/.sty files and does incremental rebuilds:
 *   1. latexmk (fast with aux files — often just one pass)
 *   2. dvisvgm for visible pages first → partial reload (seconds)
 *   3. dvisvgm for remaining pages → full reload (background)
 *   4. synctex extraction only on --full or manual request
 *
 * Usage:
 *   node scripts/watch.mjs /path/to/main.tex doc-name ["Document Title"]
 *
 * Environment:
 *   SYNC_SERVER  - Yjs sync server URL (default: ws://localhost:5176)
 *   DEBOUNCE_MS  - Rebuild debounce in ms (default: 2000)
 */

import { watch, existsSync, readFileSync } from 'fs'
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
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '2000', 10)
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

// Get visible pages from Yjs viewport info (if available)
async function getVisiblePages() {
  return new Promise((resolve) => {
    const roomId = `doc-${DOC_NAME}`
    const ws = new WebSocket(`${SYNC_URL}/${roomId}`)
    const doc = new Y.Doc()
    const yRecords = doc.getMap('tldraw')

    const timeout = setTimeout(() => { ws.close(); resolve(null) }, 2000)

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'sync') {
          clearTimeout(timeout)
          Y.applyUpdate(doc, new Uint8Array(msg.data))
          const viewport = yRecords.get('signal:viewport')
          ws.close()
          if (viewport?.pages) {
            resolve(viewport.pages)
          } else {
            resolve(null)
          }
        }
      } catch { ws.close(); resolve(null) }
    })

    ws.on('error', () => { clearTimeout(timeout); resolve(null) })
  })
}

function triggerBuild() {
  if (buildTimeout) clearTimeout(buildTimeout)
  buildTimeout = setTimeout(() => {
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
  const start = Date.now()
  console.log(`\n[watch] Rebuilding ${DOC_NAME}...`)

  try {
    // Step 1: latexmk (fast with aux files)
    const latexStart = Date.now()
    console.log('[watch] Running latexmk...')
    execSync(
      `latexmk -dvi -latex="pdflatex --output-format=dvi -synctex=1 %O %S" -interaction=nonstopmode "${texBase}.tex"`,
      { cwd: texDir, stdio: 'pipe' }
    )
    const latexElapsed = ((Date.now() - latexStart) / 1000).toFixed(1)
    console.log(`[watch] latexmk done in ${latexElapsed}s`)

    const dviFile = join(texDir, `${texBase}.dvi`)
    if (!existsSync(dviFile)) {
      throw new Error('DVI file not created')
    }

    // Step 2: Get visible pages for priority rebuild
    const visiblePages = await getVisiblePages()
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
      await signalReload(priorityPages)
    }

    // Step 4: dvisvgm for all pages
    const allStart = Date.now()
    console.log('[watch] Converting all pages...')
    execSync(
      `dvisvgm --page=1- --font-format=woff2 --bbox=papersize --output="${OUTPUT_DIR}/page-%p.svg" "${dviFile}"`,
      { cwd: texDir, stdio: 'pipe' }
    )
    const allElapsed = ((Date.now() - allStart) / 1000).toFixed(1)

    // Count pages
    totalPages = detectPageCount()
    console.log(`[watch] All ${totalPages} pages done in ${allElapsed}s`)

    // Step 5: Extract macros (fast, always do it)
    try {
      execSync(
        `node scripts/extract-preamble.js "${texPath}" "${OUTPUT_DIR}/macros.json"`,
        { cwd: PROJECT_ROOT, stdio: 'pipe' }
      )
    } catch {}

    // Step 6: Update manifest
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

    // Step 7: Full reload signal
    await signalReload(null)

    // Step 8: schedule synctex extraction on long debounce
    scheduleSynctex()

    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`[watch] Build complete in ${elapsed}s`)

  } catch (e) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.error(`[watch] Build failed in ${elapsed}s: ${e.message}`)
  }

  isBuilding = false

  if (buildQueued) {
    console.log('[watch] Changes detected during build, rebuilding...')
    doBuild()
  }
}

function scheduleSynctex() {
  if (!existsSync(join(texDir, `${texBase}.synctex.gz`))) return
  synctexStale = true
  if (synctexTimeout) clearTimeout(synctexTimeout)
  synctexTimeout = setTimeout(async () => {
    if (!synctexStale) return
    if (isBuilding) { scheduleSynctex(); return } // wait for build to finish
    synctexStale = false
    const start = Date.now()
    console.log(`[watch] Extracting synctex lookup (${SYNCTEX_DEBOUNCE_MS / 1000}s debounce)...`)
    try {
      execSync(
        `node scripts/extract-synctex-lookup.mjs "${texPath}" "${OUTPUT_DIR}/lookup.json"`,
        { cwd: PROJECT_ROOT, stdio: 'pipe' }
      )
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`[watch] Synctex extraction done in ${elapsed}s`)
    } catch (e) {
      console.error(`[watch] Synctex extraction failed: ${e.message}`)
    }
  }, SYNCTEX_DEBOUNCE_MS)
}

async function signalReload(pages) {
  const roomId = `doc-${DOC_NAME}`
  const url = `${SYNC_URL}/${roomId}`

  return new Promise((resolve) => {
    let resolved = false
    function done() {
      if (!resolved) { resolved = true; resolve() }
    }

    const ws = new WebSocket(url)
    const doc = new Y.Doc()
    const yRecords = doc.getMap('tldraw')

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'sync') {
          Y.applyUpdate(doc, new Uint8Array(msg.data))

          const signal = pages
            ? { type: 'partial', pages, timestamp: Date.now() }
            : { type: 'full', timestamp: Date.now() }

          doc.transact(() => {
            yRecords.set('signal:reload', signal)
          })

          const update = Y.encodeStateAsUpdate(doc)
          ws.send(JSON.stringify({ type: 'update', data: Array.from(update) }))

          const desc = pages ? `pages [${pages.join(',')}]` : 'full'
          console.log(`[watch] Reload signal (${desc}) sent to ${roomId}`)

          setTimeout(() => { ws.close(); done() }, 200)
        }
      } catch (e) {
        console.error(`[watch] Yjs message error: ${e.message}`)
      }
    })

    ws.on('error', (err) => {
      console.error(`[watch] Sync server not available (${err.message})`)
      done()
    })

    setTimeout(() => {
      if (!resolved) { ws.close(); done() }
    }, 5000)
  })
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
      filename.includes('.vrb') || filename.includes('.dvi') || filename.includes('.pdf')) {
    return
  }
  const ext = '.' + filename.split('.').pop()
  if (!WATCH_EXTENSIONS.has(ext)) return

  console.log(`[watch] Changed: ${filename}`)
  triggerBuild()
})

// Do an initial build on startup
totalPages = detectPageCount()
if (totalPages > 0) {
  console.log(`[watch] Existing doc has ${totalPages} pages, skipping initial build`)
  console.log('[watch] Waiting for changes...')
} else {
  console.log('[watch] No existing pages, running initial build...')
  doBuild()
}
