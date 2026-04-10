#!/usr/bin/env node
/**
 * Daemon RPC integration test.
 *
 * Spawns a mock server that:
 *   - accepts a daemon-hello and replies with daemon-welcome
 *   - sends a `list-sessions` RPC to the daemon and verifies the reply
 *   - sends an `unknown-op` RPC and verifies the daemon's error reply
 *
 * No tmux dependency: list-sessions returns an empty list when there's
 * no tmux server (the daemon's handler swallows the "no server running"
 * error). On a CI/dev box without tmux, install with `brew install tmux`
 * for the full pass; without tmux this still verifies the protocol.
 */
import { WebSocketServer } from 'ws'
import { spawn } from 'child_process'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const TMP = path.join(tmpdir(), 'fleet-daemon-rpc-' + Date.now())
mkdirSync(TMP, { recursive: true })

const PORT = 5400 + Math.floor(Math.random() * 200)
const wss = new WebSocketServer({ port: PORT, path: '/ws/fleet-daemon' })

let listSessionsResult = null
let unknownOpResult = null
let sendKeyResult = null
let helloOk = false

function send(ws, obj) { ws.send(JSON.stringify(obj)) }

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'daemon-hello') {
      helloOk = true
      send(ws, { type: 'daemon-welcome', agents: [], projects: [] })
      // Issue an RPC after a small delay to make sure the daemon's
      // dispatcher is wired.
      setTimeout(() => send(ws, { type: 'rpc', id: 'r1', op: 'list-sessions' }), 100)
      setTimeout(() => send(ws, { type: 'rpc', id: 'r2', op: 'noop-doesnt-exist' }), 200)
      // send-key against a session that doesn't exist — daemon should
      // return an error string from tmux.
      setTimeout(() => send(ws, { type: 'rpc', id: 'r3', op: 'send-key', tmux_session: 'fleet-test-nonexistent-xyz', key: 'Enter' }), 300)
    }
    if (msg.type === 'rpc-reply') {
      if (msg.id === 'r1') listSessionsResult = msg
      if (msg.id === 'r2') unknownOpResult = msg
      if (msg.id === 'r3') sendKeyResult = msg
    }
  })
})

console.log(`[rpc-test] mock server on ws://localhost:${PORT}/ws/fleet-daemon`)

const daemonScript = path.join(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'fleet-daemon.mjs')
const child = spawn(process.execPath, [daemonScript], {
  env: { ...process.env, TLDA_SERVER: `http://localhost:${PORT}`, HOME: TMP },
  stdio: ['ignore', 'inherit', 'inherit'],
})

setTimeout(() => {
  console.log('\n[rpc-test] === results ===')
  console.log(`  helloOk: ${helloOk}`)
  console.log(`  list-sessions reply: ${JSON.stringify(listSessionsResult)}`)
  console.log(`  unknown-op reply: ${JSON.stringify(unknownOpResult)}`)
  console.log(`  send-key (bad session) reply: ${JSON.stringify(sendKeyResult)}`)

  // The daemon should always reply to every rpc id, regardless of success.
  const allReplied = !!(listSessionsResult && unknownOpResult && sendKeyResult)
  // Unknown op MUST return error.
  const unknownIsError = unknownOpResult?.error?.includes('unknown op')
  // list-sessions either returns ok with sessions array, or errors out
  // (acceptable on machines without tmux).
  const listOk = listSessionsResult?.result?.ok === true || !!listSessionsResult?.error
  // send-key against bad session must return *some* result (the daemon
  // wrapper resolves with whatever tmux's error was).
  const sendOk = sendKeyResult && (sendKeyResult.error || sendKeyResult.result)

  child.kill('SIGTERM')
  wss.close()
  rmSync(TMP, { recursive: true, force: true })

  if (helloOk && allReplied && unknownIsError && listOk && sendOk) {
    console.log('PASS')
    process.exit(0)
  } else {
    console.error(`FAIL — helloOk=${helloOk} allReplied=${allReplied} unknownIsError=${unknownIsError} listOk=${listOk} sendOk=${!!sendOk}`)
    process.exit(1)
  }
}, 2500)
