// Pane bridge for the muse MSP adapter: the pane's foreground process.
//
// `muse serve` answers over pipes and stays silent over fifos on 1.3.0
// (measured: immediate pipe reply, NO ACK in 20s over fifos with correct fds).
// So the pane cannot redirect serve's stdio to fifos. Instead the pane runs
// THIS script in the foreground, and this script spawns `muse serve` as its
// child with piped stdio:
//
//   pane foreground: node muse-serve-bridge.mjs --state-dir <dir> -- <serveArgs...>
//     +- child: muse serve <serveArgs...>   (stdio: pipe/pipe/pipe)
//     +- socket: <stateDir>/bridge.sock     (daemon JSON-RPC clients)
//     +- tail:   view.jsonl rendered human-readable on this process's stdout
//
// The bridge owns the serve child's stdin/stdout: it runs
// initialize -> initialized -> session/start, appends every view notification
// to <stateDir>/view.jsonl, and relays daemon frames between the socket and
// the child. The daemon never touches serve's stdio directly.
//
// Pane-ownership is the point: killing the tmux session kills the bridge,
// which kills serve. No orphan path by construction. The serve child matches
// the existing muse `processRe`, so liveness and `resolveLiveSessionIdentity`
// keep working unchanged. `tlda attach` shows the human-readable tail below;
// the terminal is status, not input — serve takes input over MSP only.
//
// Auth comes from the launch env exactly like the TUI launch (account auth or
// deployment key via the environment, never argv). Nothing credential-bearing
// is logged.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

function usage() {
  return 'usage: muse-serve-bridge.mjs --state-dir <dir> [--bin <muse>] -- [<serveArgs...>]'
}

export function parseBridgeArgs(argv) {
  const out = { stateDir: null, bin: 'muse', serveArgs: [] }
  const rest = [...argv]
  while (rest.length) {
    const arg = rest.shift()
    if (arg === '--') { out.serveArgs = rest; break }
    if (arg === '--state-dir') out.stateDir = rest.shift() || null
    else if (arg === '--bin') out.bin = rest.shift() || 'muse'
    else throw new Error(`${usage()} (unexpected ${arg})`)
  }
  if (!out.stateDir) throw new Error(usage())
  return out
}

// One human-readable status line per view notification for the attached pane.
// Content-bearing text stays in view.jsonl; the pane shows progress, not prose.
export function summarizeViewNotification(msg) {
  const method = msg?.method
  const params = msg?.params || {}
  if (method === 'turn/started') return `turn ${params.turnId || '?'} started`
  if (method === 'turn/completed') {
    const terminal = params.terminal || params.status || '?'
    return `turn ${params.turnId || '?'} ${terminal}`
  }
  if (method === 'item/completed') {
    const item = params.item || {}
    if (item.kind === 'agentMessage') return 'assistant text committed'
    if (item.kind === 'toolCall') return `tool ${item.tool || '?'} ${item.status || ''}`.trim()
    return `item ${item.kind || '?'} completed`
  }
  if (method === 'approval/request') return 'approval requested (see daemon)'
  if (method === 'userInput/request') return 'input requested (see daemon)'
  if (method === 'session/started') return 'session started'
  return null
}

export function startBridge({ stateDir, bin = 'muse', serveArgs = [], env = process.env, onStatus = line => process.stdout.write(`${line}\n`) } = {}) {
  if (!stateDir) throw new Error('muse bridge requires a state dir')
  fs.mkdirSync(stateDir, { recursive: true })
  const sockPath = path.join(stateDir, 'bridge.sock')
  const viewPath = path.join(stateDir, 'view.jsonl')
  try { fs.unlinkSync(sockPath) } catch { /* first start */ }

  const serveEnv = { ...env }
  // Daemon parity (agent-launch/harness/muse.mjs): the pane is a login shell,
  // so the operator profile may set META_API_KEY even when the launch decided
  // account auth. Unset exactly when no key is in the launch env.
  if (!env.META_API_KEY) delete serveEnv.META_API_KEY
  const child = spawn(bin, ['serve', ...serveArgs], { stdio: ['pipe', 'pipe', 'pipe'], env: serveEnv })
  try { fs.writeFileSync(path.join(stateDir, 'serve.pid'), String(child.pid)) } catch { /* pid file is advisory liveness only */ }
  onStatus(`input via MSP; terminal is read-only status (serve pid ${child.pid})`)

  let buffer = ''
  const sockets = new Set()
  const pending = new Map()
  let nextId = 1

  function broadcast(obj) {
    const line = `${JSON.stringify(obj)}\n`
    for (const sock of sockets) {
      try { sock.write(line) } catch { /* dead subscriber; close handler removes it */ }
    }
  }

  child.stdout.on('data', chunk => {
    buffer += String(chunk)
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id != null && pending.has(msg.id)) {
        const entry = pending.get(msg.id)
        pending.delete(msg.id)
        // Restore the caller's id: the wire id above is the bridge's remap.
        entry.socket.write(`${JSON.stringify({ ...msg, id: entry.id })}\n`)
      } else if (msg.method) {
        try { fs.appendFileSync(viewPath, `${JSON.stringify(msg)}\n`) } catch { /* view tail is best-effort diagnostics */ }
        const summary = summarizeViewNotification(msg)
        if (summary) onStatus(summary)
        broadcast(msg)
      }
    }
  })

  child.stderr.on('data', chunk => {
    const text = String(chunk).trim()
    if (text) onStatus(`serve stderr: ${text.slice(0, 300)}`)
  })

  function shutdown(code) {
    for (const [, entry] of pending) {
      try { entry.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: entry.id, error: { code: -32000, message: 'muse serve unreachable: bridge shutting down' } })}\n`) } catch { /* client already gone; pending cleared below */ }
    }
    pending.clear()
    try { child.kill() } catch { /* serve already exited; exit event reports it */ }
    server.close()
    try { fs.unlinkSync(sockPath) } catch { /* first start leaves no socket */ }
    onStatus(`serve exited ${code}: restart with: node ${process.argv[1] || 'agent-runtime/muse-serve-bridge.mjs'} --state-dir ${stateDir} -- ${serveArgs.join(' ')}`.trim())
    process.exit(typeof code === 'number' ? code : 1)
  }
  child.on('exit', shutdown)
  child.on('error', err => {
    onStatus(`serve spawn failed: ${err?.message || err}`)
    process.exit(1)
  })

  const server = net.createServer(sock => {
    sockets.add(sock)
    let sockBuffer = ''
    sock.on('data', chunk => {
      sockBuffer += String(chunk)
      let idx
      while ((idx = sockBuffer.indexOf('\n')) >= 0) {
        const line = sockBuffer.slice(0, idx).trim()
        sockBuffer = sockBuffer.slice(idx + 1)
        if (!line) continue
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (!frame.method) continue
        // Notifications (no `id`) carry no ack — the `initialized` handshake
        // step arrives this way. Relay them straight to serve's stdin; only
        // commands get an id remap and a pending entry.
        if (frame.id == null) {
          try {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: frame.method, params: frame.params || {} })}\n`)
          } catch { /* serve stdin gone; shutdown path reports it */ }
          continue
        }
        const id = nextId++
        pending.set(id, { id: frame.id, socket: sock })
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: frame.method, params: frame.params || {} })}\n`)
        } catch {
          pending.delete(id)
          sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'muse serve unreachable: serve stdin unwritable (session owner unreachable)' } })}\n`)
        }
      }
    })
    sock.on('close', () => {
      sockets.delete(sock)
      for (const [id, entry] of pending) {
        if (entry.socket === sock) pending.delete(id)
      }
    })
    sock.on('error', () => { /* close follows */ })
  })
  server.listen(sockPath)

  return { child, server, sockPath, viewPath }
}

const invokedAsScript = process.argv[1] && path.basename(process.argv[1]) === 'muse-serve-bridge.mjs'
if (invokedAsScript) {
  try {
    const args = parseBridgeArgs(process.argv.slice(2))
    startBridge(args)
  } catch (err) {
    process.stderr.write(`${err?.message || err}\n`)
    process.exit(2)
  }
}
