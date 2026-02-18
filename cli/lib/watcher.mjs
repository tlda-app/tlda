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

const isTTY = process.stderr.isTTY
const dim   = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s
const green = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s
const red   = (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s

// Poll build status after a push, report result inline.
// Fire-and-forget — doesn't block the watcher.
async function awaitBuild(server, name) {
  const start = Date.now()
  const maxWait = 300_000 // 5 min
  const poll = 2000

  for (;;) {
    await new Promise(r => setTimeout(r, poll))
    if (Date.now() - start > maxWait) {
      console.log('[watch] Build still running after 5m, giving up on status poll.')
      return
    }
    try {
      const res = await fetch(`${server}/api/projects/${name}/build/status`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return
      const data = await res.json()
      if (data.status === 'building') continue

      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      if (data.status === 'success') {
        console.log(green(`[watch] Build succeeded`) + dim(` (${elapsed}s)`))
      } else {
        console.error(red(`[watch] Build failed`) + dim(` (${elapsed}s). Run \`ctd errors ${name}\` for details.`))
      }
      return
    } catch {
      return // server unreachable, don't spam
    }
  }
}

export async function startWatcher({ dir, name, debounceMs = 200, getServer }) {
  const server = getServer()
  let pushTimeout = null
  let pendingFiles = new Set()
  let pushing = false
  let pushQueued = false
  let retryDelay = 1000

  // Yjs connection for viewport + reverse sync
  let cachedViewportPages = null
  try {
    const yjsUrl = server.replace(/^http/, 'ws') + `/doc-${name}`
    await setupYjsConnection(yjsUrl, dir, (pages) => { cachedViewportPages = pages })
  } catch (e) {
    console.log(`[watch] Yjs connection failed (non-fatal): ${e.message}`)
  }

  // Initial push — rebuild if source is newer than last build
  async function initialPush() {
    try {
      const files = (await import('./source-files.mjs')).collectSourceFiles(dir)
      if (files.length > 0) {
        console.log(`[watch] Initial push: ${files.length} file(s)`)
        const res = await fetch(`${server}/api/projects/${name}/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files, sourceDir: dir }),
          signal: AbortSignal.timeout(30000),
        })
        if (res.ok) {
          const data = await res.json()
          if (data.unchanged) console.log('[watch] Source unchanged, skipping build.')
          else awaitBuild(server, name)
          retryDelay = 1000
        } else {
          console.error(`[watch] Initial push failed: ${await res.text()}`)
        }
      }
    } catch (e) {
      console.error(`[watch] Initial push failed: ${e.message}, retrying in ${retryDelay / 1000}s...`)
      setTimeout(initialPush, retryDelay)
      retryDelay = Math.min(retryDelay * 2, 30000)
    }
  }
  await initialPush()

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

    const priorityPages = cachedViewportPages || undefined

    // Detect deleted files
    const deletedFiles = filePaths.filter(p => !existsSync(join(dir, p)))
    const addedOrChanged = files  // already filtered by existsSync above

    if (addedOrChanged.length === 0 && deletedFiles.length === 0) { pushing = false; return }

    if (addedOrChanged.length > 0) console.log(`[watch] Pushing ${addedOrChanged.length} file(s): ${dim(addedOrChanged.map(f => f.path).join(', '))}`)
    if (deletedFiles.length > 0) console.log(`[watch] Deleted: ${dim(deletedFiles.join(', '))}`)

    try {
      const res = await fetch(`${server}/api/projects/${name}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: addedOrChanged, deletedFiles, priorityPages }),
        signal: AbortSignal.timeout(60000),
      })
      if (!res.ok) {
        const text = await res.text()
        console.error(`[watch] Push failed: ${text}`)
      } else {
        retryDelay = 1000
        // Poll for build result
        awaitBuild(server, name)
      }
    } catch (e) {
      console.error(`[watch] Push failed: ${e.message}, retrying in ${retryDelay / 1000}s...`)
      for (const f of filePaths) pendingFiles.add(f)
      pushing = false
      setTimeout(pushChanges, retryDelay)
      retryDelay = Math.min(retryDelay * 2, 30000)
      return
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

  // Keep process alive, don't die on errors or signals
  process.on('SIGINT', () => { console.log('\n[watch] Stopped.'); process.exit(0) })
  process.on('SIGTERM', () => { console.log('\n[watch] Got SIGTERM, ignoring (use SIGINT to stop).') })
  process.on('SIGHUP', () => { console.log('[watch] Got SIGHUP, ignoring.') })
  process.on('SIGPIPE', () => {}) // silently ignore broken pipes
  process.on('uncaughtException', (e) => {
    console.error(`[watch] Uncaught exception (continuing): ${e.stack || e.message}`)
  })
  process.on('unhandledRejection', (e) => {
    console.error(`[watch] Unhandled rejection (continuing): ${e?.stack || e?.message || e}`)
  })

  // Safety net: keep the event loop alive even if all handles close.
  // fs.watch should keep it alive, but this ensures it during reconnection gaps.
  setInterval(() => {}, 30000)
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
  let everConnected = false
  let currentlyConnected = false
  function connect() {
    try {
      ws = new WebSocket(url)
    } catch (e) {
      if (everConnected) console.log(`[watch] Yjs reconnect failed: ${e.message}`)
      setTimeout(connect, 3000)
      return
    }
    ws.on('open', () => {
      if (everConnected) console.log('[watch] Yjs reconnected.')
      everConnected = true
      currentlyConnected = true
    })
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'sync' || msg.type === 'update') {
          Y.applyUpdate(doc, new Uint8Array(msg.data), 'remote')
        }
      } catch {}
    })
    ws.on('close', () => {
      if (currentlyConnected) {
        console.log('[watch] Yjs disconnected, will reconnect...')
        currentlyConnected = false
      }
      setTimeout(connect, 3000)
    })
    ws.on('error', () => {}) // errors followed by 'close', which reconnects
  }

  connect()
}
