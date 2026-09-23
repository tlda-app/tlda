// Thin MSP host bridge for the muse harness.
//
// `muse serve` IS the session owner: it must run somewhere durable so the
// session (model, loop, tools, persistence) survives the client's process.
// This module owns exactly the host side of that relationship and nothing
// else: launch the bridge in the agent's pane, speak JSON-RPC 2.0
// newline-delimited frames to it over a Unix socket, and route view events to
// the existing muse-activity parser shape. No send-keys, no terminal scraping.
//
// Layout (per agent, identified by tmux session):
//   stateDir = <TMPDIR>/tlda-muse-serve/<encoded-tmux-session>/
//     bridge.sock  daemon JSON-RPC clients (one line-delimited frame each)
//     serve.pid    serve child's pid (for liveness checks, never for input)
//     session.id   MSP sessionId once session/start has returned it
//     view.jsonl   appended raw view notifications (turn/item/approval/...)
//     state.json   { sessionId, turnId, status } — crash recovery, not authority
//
// The pane runs the bridge (`muse-serve-bridge.mjs`), which spawns `muse
// serve` as its child with PIPED stdio — serve answers over pipes and stays
// silent over fifos on 1.3.0 (measured), so there are no fifos anywhere. The
// bridge tails view.jsonl to the pane in human-readable form, which keeps
// `tlda attach` (tmux attach) working as a terminal surface while all input
// goes through MSP. If the bridge or serve child is not reachable, every op
// below fails with an exact protocol-limitation error — never a silent tmux
// fallback.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

// RFC 9562 UUIDv7: millisecond timestamp + version nibble + random. Proven
// against the live server during probing — every command needs one.
export function uuid7() {
  const ms = BigInt(Date.now())
  const randA = BigInt(Math.floor(Math.random() * 0xfff))
  const randB = (BigInt(Math.floor(Math.random() * 0xffffffff)) << 32n) | BigInt(Math.floor(Math.random() * 0xffffffff))
  const v = (ms << 80n) | (7n << 76n) | (randA << 64n) | (2n << 62n) | (randB & ((1n << 62n) - 1n))
  const hex = v.toString(16).padStart(32, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function serveStateDir(tmuxSession, { tmpdir = os.tmpdir() } = {}) {
  return path.join(tmpdir, 'tlda-muse-serve', encodeURIComponent(String(tmuxSession)))
}

// The pane command. Runs the bridge in the pane foreground; the bridge spawns
// `muse serve` as its child with piped stdio (serve is silent over fifos on
// 1.3.0 — measured — so there are no fifos anywhere) and tails view.jsonl to
// the pane so `tlda attach` keeps working. `serveArgs` carries the
// sandbox/auth stance the daemon configured (--disable-sandbox etc. via
// harnessOptions); auth itself comes from the launch env exactly like the TUI
// launch — never in the command line.
export function servePaneCommand({ stateDir, serveArgs = [], envAssignments = {}, bridgePath = null } = {}) {
  if (!stateDir) throw new Error('muse serve-in-pane requires a state dir')
  const assignments = Object.entries(envAssignments).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable: ${key}`)
    return `${key}=${sq(value)}`
  })
  const bridge = bridgePath || path.join(path.dirname(fileURLToPath(import.meta.url)), 'muse-serve-bridge.mjs')
  const inner = [
    ...assignments,
    'node', bridge,
    '--state-dir', stateDir,
    '--',
    ...serveArgs,
  ].join(' ')
  return `zsh -lc ${sq(inner)}`
}

// Attach a line-delimited JSON-RPC reader to a stream. Responses (with `id`)
// resolve pending commands; notifications (with `method`) go to onEvent.
// `input` is the read side (serve stdout); `output` is the write side (serve
// stdin) — split because the pane path holds them as two separate fifos.
// When `output` is omitted, sends fall back to `input.write` (bare-child
// probes where stdio is one duplex object).
// Returns { send(method, params, opts), notify(method, params), close(), pending }.
export function createMspChannel({ input, output = null, onEvent = () => {}, commandTimeoutMs = 120000, now = Date.now } = {}) {
  if (!input) throw new Error('msp channel requires an input stream')
  let nextId = 1
  const pending = new Map()
  let buffer = ''
  let closed = false

  function failAll(err) {
    for (const [, entry] of pending) entry.reject(err)
    pending.clear()
  }

  function onData(chunk) {
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
        clearTimeout(entry.timer)
        if (msg.error) entry.reject(Object.assign(new Error(msg.error.message || 'msp error'), { code: msg.error.code, data: msg.error.data }))
        else entry.resolve(msg.result)
      } else if (msg.method) {
        onEvent(msg)
      }
    }
  }

  input.on('data', onData)
  input.on('error', err => failAll(err))
  input.on('close', () => { closed = true; failAll(new Error('msp channel closed: serve stdio unreachable')) })

  function writer() {
    if (output?.write) return body => output.write(body)
    if (input.write) return body => input.write(body)
    return null
  }

  function send(method, params = {}, { timeoutMs = commandTimeoutMs, write = null } = {}) {
    if (closed) return Promise.reject(new Error(`msp ${method} failed: serve stdio is closed (session owner unreachable)`))
    const id = nextId++
    // The wire carries exactly what the caller passes — every command mints
    // its own UUIDv7 commandId via uuid7() (proven against the live server).
    // Nothing is injected here: `initialize` takes no commandId, and a strict
    // server must never see a param it did not ask for.
    const body = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`msp ${method} timed out after ${timeoutMs}ms (serve gave no ack)`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer, method, startedAt: now() })
      try {
        if (write) write(body, id)
        else {
          const w = writer()
          if (!w) throw new Error(`msp ${method} failed: no writable serve stdin (session owner unreachable)`)
          w(body)
        }
      } catch (err) {
        clearTimeout(timer)
        pending.delete(id)
        reject(err)
      }
    }).then(result => ({ result, id }))
  }

  // Fire-and-forget JSON-RPC notification (no `id`, no ack). Used for the
  // `initialized` handshake step and any future server notify the schema adds.
  function notify(method, params = {}) {
    if (closed) throw new Error(`msp ${method} failed: serve stdio is closed (session owner unreachable)`)
    const w = writer()
    if (!w) throw new Error(`msp ${method} failed: no writable serve stdin (session owner unreachable)`)
    w(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  function close() {
    closed = true
    try { input.removeListener('data', onData) } catch { /* already gone */ }
    failAll(new Error('msp channel closed by client'))
  }

  return { send, notify, close, pending }
}

// Spawn a local `muse serve` child for tests and one-shot probes — NOT the
// pane path. The pane path uses servePaneCommand (above) so the session owner
// lives in tmux; this helper is for verification runs that want a bare host.
export function spawnServeHost({ args = [], env = process.env, bin = 'muse' } = {}) {
  const child = spawn(bin, ['serve', ...args], { stdio: ['pipe', 'pipe', 'pipe'], env })
  return child
}

// Open a live channel to a bridge socket: connect, wrap the socket in the same
// { send, notify, close, pending } shape as the stdio channel, run the
// two-step initialize handshake. Same ops, same mapping — the transport is the
// only difference. Pane wiring (bridge command, servePaneCommand) is tested by
// unit test, not by spawning panes here.
export async function openProbeChannel({ args = [], env = process.env, bin = 'muse', onEvent = () => {}, commandTimeoutMs = 120000 } = {}) {
  const child = spawnServeHost({ args, env, bin })
  const channel = createMspChannel({ input: child.stdout, output: child.stdin, onEvent, commandTimeoutMs })
  const result = await channel.send('initialize', { clientInfo: { name: 'tlda', version: '1' } })
  channel.notify('initialized')
  return { child, channel, initializeResult: result }
}

export { randomUUID }
