/**
 * File watcher for ctd CLI.
 *
 * Watches source files and pushes changes to the server.
 * The server handles building — the watcher only detects and uploads.
 *
 * Also maintains a Yjs connection for:
 *   - Viewport tracking (priority pages for partial rebuilds)
 *   - Reverse sync (open Zed at the line the user clicked)
 */

import { watch, existsSync } from 'fs'
import { join, resolve } from 'path'
import { spawn } from 'child_process'
import { isSourceFile, isJunk, readForUpload } from './source-files.mjs'

export async function startWatcher({ dir, name, debounceMs = 200, getServer }) {
  const server = getServer()
  let pushTimeout = null
  let pendingFiles = new Set()
  let pushing = false
  let pushQueued = false

  // Yjs connection for viewport + reverse sync
  let cachedViewportPages = null
  try {
    const yjsUrl = server.replace(/^http/, 'ws') + `/doc-${name}`
    await setupYjsConnection(yjsUrl, dir, (pages) => { cachedViewportPages = pages })
  } catch (e) {
    console.log(`[watch] Yjs connection failed (non-fatal): ${e.message}`)
  }

  async function pushChanges() {
    if (pushing) { pushQueued = true; return }
    pushing = true

    const filePaths = [...pendingFiles]
    pendingFiles.clear()

    const files = []
    for (const relPath of filePaths) {
      const fullPath = join(dir, relPath)
      if (!existsSync(fullPath)) continue
      files.push({ path: relPath, ...readForUpload(fullPath) })
    }

    if (files.length === 0) { pushing = false; return }

    const priorityPages = cachedViewportPages || undefined

    console.log(`[watch] Pushing ${files.length} file(s): ${filePaths.join(', ')}`)
    try {
      const res = await fetch(`${server}/api/projects/${name}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files, priorityPages }),
      })
      if (!res.ok) {
        const text = await res.text()
        console.error(`[watch] Push failed: ${text}`)
      } else {
        console.log('[watch] Push accepted, build started on server.')
      }
    } catch (e) {
      console.error(`[watch] Push failed: ${e.message}`)
    }

    pushing = false
    if (pushQueued) {
      pushQueued = false
      pushChanges()
    }
  }

  console.log('[watch] Watching for changes...')

  watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename) return

    if (isJunk(filename)) return
    if (filename.includes('node_modules') || filename.includes('.git')) return
    if (!isSourceFile(filename)) return

    console.log(`[watch] Changed: ${filename}`)
    pendingFiles.add(filename)

    if (pushTimeout) clearTimeout(pushTimeout)
    pushTimeout = setTimeout(pushChanges, debounceMs)
  })

  // Keep process alive
  process.on('SIGINT', () => { console.log('\n[watch] Stopped.'); process.exit(0) })
}

async function setupYjsConnection(url, texDir, onViewportUpdate) {
  // Dynamic import — these may not be installed in the CLI context
  let Y, WebSocket
  try {
    Y = await import('yjs')
    WebSocket = (await import('ws')).default
  } catch {
    return // ws/yjs not available — skip Yjs features
  }

  const doc = new Y.Doc()
  const yRecords = doc.getMap('tldraw')

  yRecords.observe((event) => {
    event.changes.keys.forEach((change, key) => {
      if (key === 'signal:viewport' && (change.action === 'add' || change.action === 'update')) {
        const viewport = yRecords.get(key)
        if (viewport?.pages) onViewportUpdate(viewport.pages)
      }
      if (key === 'signal:reverse-sync' && (change.action === 'add' || change.action === 'update')) {
        const sig = yRecords.get(key)
        if (sig?.line && sig?.file) {
          const target = `${resolve(texDir, sig.file)}:${sig.line}`
          console.log(`[reverse-sync] Opening ${target}`)
          spawn('zed', [target], { stdio: 'ignore', detached: true }).unref()
        }
      }
    })
  })

  doc.on('update', (update, origin) => {
    if (origin === 'remote') return
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'update', data: Array.from(update) }))
    }
  })

  let ws
  function connect() {
    ws = new WebSocket(url)
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'sync' || msg.type === 'update') {
          Y.applyUpdate(doc, new Uint8Array(msg.data), 'remote')
        }
      } catch {}
    })
    ws.on('close', () => setTimeout(connect, 2000))
    ws.on('error', () => {})
  }

  connect()
}
