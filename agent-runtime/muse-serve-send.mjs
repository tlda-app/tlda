// Daemon-side send-text routing for muse serve agents.
//
// `rpcSendText` (daemon/terminal-rpc.mjs) calls `resolveMuseServeSend` with the
// agent id and text. This module answers one question: is this agent a muse
// agent with a live bridge socket? If yes, it sends the text as an MSP turn
// over the socket and returns the turn ack. If no, it returns null and the
// caller keeps the existing pty/tmux path — never a silent fallback, just the
// current behavior for agents this adapter does not own.
//
// Harness kind comes from `agent.metadata.kind` via `harnessKindForAgent` (the
// same derivation harness-runtime uses — never inferred). The bridge socket
// lives at `<serveStateDir(tmuxSession)>/bridge.sock`. MSP session binding
// lives in `<stateDir>/session.id`, written by the session-start path; when it
// is absent the adapter does not own this send and returns null.
//
// A connected-but-unreachable bridge (socket gone, serve dead) is an exact
// protocol-limitation error, not a quiet fallthrough: the send belonged to
// this adapter and its owner is down.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { harnessKindForAgent } from './daemon-guards.mjs'
import { serveStateDir } from './muse-serve-host.mjs'
import { mspSend } from './muse-serve-ops.mjs'

function readSessionId(stateDir) {
  try {
    const id = fs.readFileSync(path.join(stateDir, 'session.id'), 'utf8').trim()
    return id || null
  } catch {
    return null
  }
}

export function createMuseServeSend({ resolveAgent, log = console } = {}) {
  if (!resolveAgent) throw new Error('muse serve send requires resolveAgent')
  return async function resolveMuseServeSend({ agentId, text } = {}) {
    const agent = resolveAgent({ agentId })
    if (!agent) return null
    let kind
    try {
      kind = harnessKindForAgent(agent, log)
    } catch {
      return null
    }
    if (kind !== 'muse') return null
    const tmuxSession = agent.tmuxSession || agent.tmux_session
    if (!tmuxSession || !text) return null
    const stateDir = serveStateDir(tmuxSession)
    const sessionId = readSessionId(stateDir)
    // No bound MSP session: this send is not ours. Null keeps the current
    // terminal path — the agent is muse but serve-mode was never started.
    if (!sessionId) return null
    const sockPath = path.join(stateDir, 'bridge.sock')
    if (!fs.existsSync(sockPath)) {
      throw new Error(`msp send failed: muse serve unreachable at ${sockPath} (bridge socket absent — bridge or serve is down, session ${sessionId})`)
    }
    const socket = net.createConnection(sockPath)
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve)
      socket.on('error', reject)
    }).catch(err => {
      throw new Error(`msp send failed: muse serve unreachable at ${sockPath} (${err?.message || err})`)
    })
    const channel = {
      send: (method, params) => new Promise((resolve, reject) => {
        const id = 1
        const timer = setTimeout(() => {
          socket.destroy()
          reject(new Error(`msp ${method} timed out (serve gave no ack)`))
        }, 120000)
        let buffer = ''
        const onData = chunk => {
          buffer += String(chunk)
          let idx
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim()
            buffer = buffer.slice(idx + 1)
            if (!line) continue
            let msg
            try { msg = JSON.parse(line) } catch { continue }
            if (msg.id == null) continue
            clearTimeout(timer)
            socket.removeListener('data', onData)
            if (msg.error) reject(Object.assign(new Error(msg.error.message || 'msp error'), { code: msg.error.code }))
            else resolve({ result: msg.result, id: msg.id })
            socket.destroy()
          }
        }
        socket.on('data', onData)
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      }),
      notify: (method, params = {}) => {
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
      },
    }
    try {
      const ack = await mspSend(channel, { sessionId, text })
      return { ok: true, via: 'msp', turnId: ack?.turnId || null }
    } finally {
      try { socket.destroy() } catch { /* socket already closed by the ack path */ }
    }
  }
}
