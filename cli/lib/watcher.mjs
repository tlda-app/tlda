/**
 * File watcher for ctd CLI.
 *
 * Watches source files and pushes changes to the server.
 * The server handles building — the watcher only detects and uploads.
 *
 * Also connects to the signal SSE stream for:
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
async function awaitBuild(server, name, authHeaders = {}) {
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
        headers: authHeaders,
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

export async function startWatcher({ dir, name, debounceMs = 200, getServer, getToken }) {
  const server = getServer()
  const token = getToken?.() || null
  const authHeaders = token ? { 'Authorization': `Bearer ${token}` } : {}
  let pushTimeout = null
  let pendingFiles = new Set()
  let pushing = false
  let pushQueued = false
  let retryDelay = 1000

  // Signal SSE stream for viewport + reverse sync
  let cachedViewportPages = null
  try {
    setupSignalStream(server, name, authHeaders, dir, (pages) => { cachedViewportPages = pages })
  } catch (e) {
    console.log(`[watch] Signal stream failed (non-fatal): ${e.message}`)
  }

  // Initial push — rebuild if source is newer than last build
  async function initialPush() {
    try {
      const files = (await import('./source-files.mjs')).collectSourceFiles(dir)
      if (files.length > 0) {
        console.log(`[watch] Initial push: ${files.length} file(s)`)
        const res = await fetch(`${server}/api/projects/${name}/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ files, sourceDir: dir }),
          signal: AbortSignal.timeout(30000),
        })
        if (res.ok) {
          const data = await res.json()
          if (data.unchanged) console.log('[watch] Source unchanged, skipping build.')
          else awaitBuild(server, name, authHeaders)
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
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ files: addedOrChanged, deletedFiles, priorityPages }),
        signal: AbortSignal.timeout(60000),
      })
      if (!res.ok) {
        const text = await res.text()
        if (res.status === 401 || res.status === 403) {
          console.error(`[watch] Authentication failed (${res.status}). Check your token with "ctd config".`)
          process.exit(1)
        }
        console.error(`[watch] Push failed: ${text}`)
      } else {
        retryDelay = 1000
        // Poll for build result
        awaitBuild(server, name, authHeaders)
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

/**
 * Connect to the signal SSE stream for viewport updates + reverse sync.
 * Replaces the old Yjs WebSocket connection — signals now go through HTTP.
 */
function setupSignalStream(server, name, authHeaders, texDir, onViewportUpdate) {
  let lastReverseTs = 0

  function connect() {
    const url = `${server}/api/projects/${name}/signal/stream`
    fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(0) }).catch(() => {})
    // Use native http for SSE (fetch doesn't stream in Node < 22 without extra work)
    import('http').then(({ default: http }) => {
      const parsed = new URL(url)
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: { ...authHeaders, 'Accept': 'text/event-stream' },
      }
      const req = http.get(opts, (res) => {
        if (res.statusCode !== 200) {
          console.log(`[watch] Signal stream returned ${res.statusCode}`)
          res.resume()
          setTimeout(connect, 5000)
          return
        }
        let buffer = ''
        res.on('data', (chunk) => {
          buffer += chunk.toString()
          let idx
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx).trim()
            buffer = buffer.slice(idx + 2)
            if (!block.startsWith('data: ')) continue
            try {
              const signal = JSON.parse(block.slice(6))
              if (signal.key === 'signal:viewport' && signal.pages) {
                onViewportUpdate(signal.pages)
              }
              if (signal.key === 'signal:reverse-sync' && signal.line && signal.file) {
                if (signal.timestamp && signal.timestamp <= lastReverseTs) continue
                lastReverseTs = signal.timestamp || Date.now()
                const target = `${resolve(texDir, signal.file)}:${signal.line}`
                console.log(`[reverse-sync] Opening ${target}`)
                spawn('zed', [target], { stdio: 'ignore', detached: true }).unref()
              }
            } catch {}
          }
        })
        res.on('end', () => {
          console.log('[watch] Signal stream ended, reconnecting...')
          setTimeout(connect, 3000)
        })
        res.on('error', () => {
          setTimeout(connect, 3000)
        })
      })
      req.on('error', () => {
        setTimeout(connect, 5000)
      })
    })
  }

  // Seed viewport from cached signal
  fetch(`${server}/api/projects/${name}/signal/${encodeURIComponent('signal:viewport')}`, { headers: authHeaders })
    .then(r => r.ok ? r.json() : null)
    .then(sig => { if (sig?.pages) onViewportUpdate(sig.pages) })
    .catch(() => {})

  connect()
}
