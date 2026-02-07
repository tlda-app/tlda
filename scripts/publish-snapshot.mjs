#!/usr/bin/env node
/**
 * Publish a static snapshot to GitHub Pages.
 *
 * Exports current annotations from the Yjs sync server, bakes them into
 * a static JSON file, builds the viewer, and deploys to GitHub Pages.
 *
 * The static viewer loads annotations from the baked JSON in read-only mode
 * when no sync server is available.
 *
 * Usage:
 *   node scripts/publish-snapshot.mjs [doc-name]
 *   npm run publish-snapshot -- bregman
 *
 * Environment:
 *   SYNC_SERVER  - Yjs sync server URL (default: ws://localhost:5176)
 */

import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { networkInterfaces } from 'os'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

const DOC_NAME = process.argv[2]
if (!DOC_NAME) {
  console.error('Usage: node scripts/publish-snapshot.mjs <doc-name>')
  console.error('Example: node scripts/publish-snapshot.mjs bregman')
  process.exit(1)
}

const SYNC_URL = process.env.SYNC_SERVER || 'ws://localhost:5176'
const roomId = `doc-${DOC_NAME}`

// Detect Tailscale or LAN IP for live URL
function detectLiveHost() {
  const ifaces = networkInterfaces()
  for (const [name, nets] of Object.entries(ifaces)) {
    if (!nets) continue
    for (const net of nets) {
      if (net.family !== 'IPv4' || net.internal) continue
      // Prefer Tailscale (100.x.y.z or utun interface)
      if (name.includes('utun') || net.address.startsWith('100.'))
        return net.address
    }
  }
  // Fall back to LAN
  for (const nets of Object.values(ifaces)) {
    if (!nets) continue
    for (const net of nets) {
      if (net.family !== 'IPv4' || net.internal) continue
      if (net.address.startsWith('10.') || net.address.startsWith('192.168.') || net.address.startsWith('172.'))
        return net.address
    }
  }
  return null
}

console.log(`[publish] Exporting annotations for ${DOC_NAME} from ${SYNC_URL}/${roomId}`)

// Step 1: Export annotations from Yjs
async function exportAnnotations() {
  return new Promise((resolve, reject) => {
    const url = `${SYNC_URL}/${roomId}`
    const ws = new WebSocket(url)
    const doc = new Y.Doc()
    const yRecords = doc.getMap('tldraw')

    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('Timeout connecting to sync server'))
    }, 10000)

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'sync') {
          clearTimeout(timeout)
          Y.applyUpdate(doc, new Uint8Array(msg.data))

          // Extract all annotation records (shapes, not signals)
          const annotations = {}
          yRecords.forEach((record, id) => {
            if (id.startsWith('signal:')) return
            annotations[id] = record
          })

          ws.close()
          resolve(annotations)
        }
      } catch (e) {
        reject(e)
      }
    })

    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`Cannot connect to sync server: ${err.message}`))
    })
  })
}

try {
  const annotations = await exportAnnotations()
  const annotationCount = Object.keys(annotations).length
  console.log(`[publish] Exported ${annotationCount} records`)

  // Step 2: Write static annotations file
  const snapshotDir = join(PROJECT_ROOT, 'public', 'docs', DOC_NAME)
  if (!existsSync(snapshotDir)) {
    mkdirSync(snapshotDir, { recursive: true })
  }

  // Detect live session URL
  const liveHost = detectLiveHost()
  const liveUrl = liveHost ? `http://${liveHost}:5173/?doc=${DOC_NAME}` : null
  if (liveUrl) {
    console.log(`[publish] Live session URL: ${liveUrl}`)
  }

  const snapshotPath = join(snapshotDir, 'annotations.json')
  writeFileSync(snapshotPath, JSON.stringify({
    room: roomId,
    doc: DOC_NAME,
    exportedAt: new Date().toISOString(),
    liveUrl,
    records: annotations,
  }, null, 2))
  console.log(`[publish] Wrote ${snapshotPath}`)

  // Step 3: Build the static site
  console.log('[publish] Building static site...')
  execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' })

  // Step 4: Deploy to GitHub Pages
  console.log('[publish] Deploying to GitHub Pages...')
  execSync('npx gh-pages -d dist', { cwd: PROJECT_ROOT, stdio: 'inherit' })

  console.log('[publish] Done! Snapshot published to GitHub Pages.')

} catch (e) {
  console.error(`[publish] Error: ${e.message}`)
  process.exit(1)
}
