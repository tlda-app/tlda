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
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const TMP = path.join(tmpdir(), 'fleet-daemon-rpc-' + Date.now())
const DAEMON_CFG = path.join(TMP, 'daemon-config')
const ARG_LOG = path.join(TMP, 'spawn-args.log')
mkdirSync(TMP, { recursive: true })
mkdirSync(DAEMON_CFG, { recursive: true })

const PORT = 5400 + Math.floor(Math.random() * 200)
const wss = new WebSocketServer({ port: PORT, path: '/ws/fleet-daemon' })

let listSessionsResult = null
let unknownOpResult = null
let sendKeyResult = null
let spawnFailResult = null
let spawnPhantomResult = null
let spawnStartupFailureResult = null
let spawnStartupFailureEvent = null
let captureVisibleResult = null
let captureBackscrollResult = null
let helloOk = false

function send(ws, obj) { ws.send(JSON.stringify(obj)) }

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'daemon-hello') {
      helloOk = true
      send(ws, { type: 'daemon-welcome', agents: [], projects: [{ name: 'mathdoc', profile: 'math' }] })
      // Issue an RPC after a small delay to make sure the daemon's
      // dispatcher is wired.
      setTimeout(() => send(ws, { type: 'rpc', id: 'r1', op: 'list-sessions' }), 100)
      setTimeout(() => send(ws, { type: 'rpc', id: 'r2', op: 'noop-doesnt-exist' }), 200)
      // send-key against a session that doesn't exist — daemon should
      // return an error string from tmux.
      setTimeout(() => send(ws, { type: 'rpc', id: 'r3', op: 'send-key', tmux_session: 'fleet-test-nonexistent-xyz', key: 'Enter' }), 300)
      // spawn must not report ok before the launcher has actually succeeded.
      setTimeout(() => send(ws, {
        type: 'rpc',
        id: 'r4',
        op: 'spawn',
        agent_id: 'fleet:falsecanary',
        name: 'false-success-canary',
        model: 'sonnet',
        kind: 'claude',
        requestedCapability: 'full',
        callerRung: 'write',
      }), 400)
      // Even a zero-exit launcher is not success unless the reported tmux
      // session exists and is usable.
      setTimeout(() => send(ws, { type: 'rpc', id: 'r5', op: 'spawn', name: 'phantom-success-canary', model: 'sonnet', kind: 'claude' }), 500)
      // A launcher that creates a tmux session can still hit a harness startup
      // failure. The daemon returns the verified launch and surfaces the later
      // harness startup failure as a typed async event.
      setTimeout(() => send(ws, { type: 'rpc', id: 'r6', op: 'spawn', name: 'startup-auth-canary', model: 'sonnet', kind: 'claude' }), 600)
      // Terminal hover seeds must capture only the visible pane; explicit
      // backscroll capture remains available for lightbox/history views.
      setTimeout(() => send(ws, { type: 'rpc', id: 'r7', op: 'capture-pane', tmux_session: 'fleet-visible-canary', visible: true }), 700)
      setTimeout(() => send(ws, { type: 'rpc', id: 'r8', op: 'capture-pane', tmux_session: 'fleet-backscroll-canary', lines: 80 }), 800)
    }
    if (msg.type === 'rpc-reply') {
      if (msg.id === 'r1') listSessionsResult = msg
      if (msg.id === 'r2') unknownOpResult = msg
      if (msg.id === 'r3') sendKeyResult = msg
      if (msg.id === 'r4') spawnFailResult = msg
      if (msg.id === 'r5') spawnPhantomResult = msg
      if (msg.id === 'r6') spawnStartupFailureResult = msg
      if (msg.id === 'r7') captureVisibleResult = msg
      if (msg.id === 'r8') captureBackscrollResult = msg
    }
    if (msg.type === 'spawn-startup-failed') spawnStartupFailureEvent = msg
  })
})

console.log(`[rpc-test] mock server on ws://localhost:${PORT}/ws/fleet-daemon`)

const fakeSpawn = path.join(TMP, 'fake-fleet-spawn')
writeFileSync(fakeSpawn, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(ARG_LOG)}
case "$*" in
  *phantom-success-canary*)
    echo "fleet-phantom-success-canary (fleet:phantom123) spawned in /tmp"
    exit 0
    ;;
  *startup-auth-canary*)
    echo "fleet-startup-auth-canary (fleet:startupauth123) spawned in /tmp"
    exit 0
    ;;
  *)
    echo "fake launcher failed before tmux" >&2
    exit 42
    ;;
esac
`)
chmodSync(fakeSpawn, 0o755)

const fakeTmux = path.join(TMP, 'tmux')
writeFileSync(fakeTmux, `#!/bin/sh
cmd="$1"
if [ "$cmd" = "list-sessions" ]; then
  exit 0
fi
if [ "$cmd" = "has-session" ]; then
  case "$*" in
    *fleet-startup-auth-canary*) exit 0 ;;
    *fleet-visible-canary*) exit 0 ;;
    *fleet-backscroll-canary*) exit 0 ;;
    *) echo "can't find session" >&2; exit 1 ;;
  esac
fi
if [ "$cmd" = "capture-pane" ]; then
  case "$*" in
    *fleet-startup-auth-canary*)
      echo "Claude Code"
      echo "Not logged in · Run /login"
      exit 0
      ;;
    *fleet-visible-canary*|*fleet-backscroll-canary*)
      echo "ARGS:$*"
      exit 0
      ;;
    *) echo "can't find pane" >&2; exit 1 ;;
  esac
fi
echo "unsupported fake tmux command: $*" >&2
exit 1
`)
chmodSync(fakeTmux, 0o755)

const daemonScript = path.join(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'fleet-daemon.mjs')
const child = spawn(process.execPath, [daemonScript], {
  env: {
    ...process.env,
    TLDA_SERVER: `http://localhost:${PORT}`,
    TLDA_DAEMON_CONFIG_DIR: DAEMON_CFG,
    HOME: TMP,
    FLEET_SPAWN: fakeSpawn,
    PATH: `${TMP}:${process.env.PATH || ''}`,
    TLDA_SPAWN_STARTUP_FAILURE_PROBE_MS: '20',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
})

setTimeout(() => {
  console.log('\n[rpc-test] === results ===')
  console.log(`  helloOk: ${helloOk}`)
  console.log(`  list-sessions reply: ${JSON.stringify(listSessionsResult)}`)
  console.log(`  unknown-op reply: ${JSON.stringify(unknownOpResult)}`)
  console.log(`  send-key (bad session) reply: ${JSON.stringify(sendKeyResult)}`)
  console.log(`  spawn failure reply: ${JSON.stringify(spawnFailResult)}`)
  console.log(`  phantom spawn reply: ${JSON.stringify(spawnPhantomResult)}`)
  console.log(`  startup failure spawn reply: ${JSON.stringify(spawnStartupFailureResult)}`)
  console.log(`  startup failure event: ${JSON.stringify(spawnStartupFailureEvent)}`)
  console.log(`  visible capture reply: ${JSON.stringify(captureVisibleResult)}`)
  console.log(`  backscroll capture reply: ${JSON.stringify(captureBackscrollResult)}`)

  // The daemon should always reply to every rpc id, regardless of success.
  const allReplied = !!(listSessionsResult && unknownOpResult && sendKeyResult && spawnFailResult && spawnPhantomResult && spawnStartupFailureResult && captureVisibleResult && captureBackscrollResult)
  // Unknown op MUST return error.
  const unknownIsError = unknownOpResult?.error?.includes('unknown op')
  // list-sessions either returns ok with sessions array, or errors out
  // (acceptable on machines without tmux).
  const listOk = listSessionsResult?.result?.ok === true || !!listSessionsResult?.error
  // send-key against bad session must return *some* result (the daemon
  // wrapper resolves with whatever tmux's error was).
  const sendOk = sendKeyResult && (sendKeyResult.error || sendKeyResult.result)
  const spawnFailureSurfaced = spawnFailResult?.result?.ok === false
    && /fake launcher failed before tmux/.test(spawnFailResult.result.error || '')
  const phantomSpawnRejected = spawnPhantomResult?.result?.ok === false
    && spawnPhantomResult.result.tmux_session === 'fleet-phantom-success-canary'
    && /tmux session is not usable/.test(spawnPhantomResult.result.error || '')
  const startupFailureSurfaced = spawnStartupFailureResult?.result?.ok === true
    && spawnStartupFailureResult.result.tmux_session === 'fleet-startup-auth-canary'
    && spawnStartupFailureResult.result.grantedCapability === 'write'
  const startupFailureEventSent = spawnStartupFailureEvent?.agent_id === 'fleet:startupauth123'
    && spawnStartupFailureEvent?.code === 'account-auth-startup-error'
  const visibleCaptureUsesCurrentPane = captureVisibleResult?.result?.ok === true
    && /capture-pane/.test(captureVisibleResult.result.pane || '')
    && !/(^| )-S( |$)/.test(captureVisibleResult.result.pane || '')
  const backscrollCaptureUsesStart = captureBackscrollResult?.result?.ok === true
    && /(^| )-S -80(\s|$)/.test(captureBackscrollResult.result.pane || '')
  const argLog = readFileSync(ARG_LOG, 'utf8')
  const falseSuccessArgs = argLog.split('\n').find(line => line.includes('false-success-canary')) || ''
  const daemonGrantedWrite = falseSuccessArgs.includes('--spawn-capability write')
    && falseSuccessArgs.includes('--agent-id fleet:falsecanary')
    && falseSuccessArgs.includes('--mode default')
    && !falseSuccessArgs.includes('--spawn-capability full')

  child.kill('SIGTERM')
  wss.close()
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

  if (helloOk && allReplied && unknownIsError && listOk && sendOk && spawnFailureSurfaced && phantomSpawnRejected && startupFailureSurfaced && startupFailureEventSent && visibleCaptureUsesCurrentPane && backscrollCaptureUsesStart && daemonGrantedWrite) {
    console.log('PASS')
    process.exit(0)
  } else {
    console.error(`FAIL — helloOk=${helloOk} allReplied=${allReplied} unknownIsError=${unknownIsError} listOk=${listOk} sendOk=${!!sendOk} spawnFailureSurfaced=${spawnFailureSurfaced} phantomSpawnRejected=${phantomSpawnRejected} startupFailureSurfaced=${startupFailureSurfaced} startupFailureEventSent=${startupFailureEventSent} visibleCaptureUsesCurrentPane=${visibleCaptureUsesCurrentPane} backscrollCaptureUsesStart=${backscrollCaptureUsesStart} daemonGrantedWrite=${daemonGrantedWrite} falseSuccessArgs=${JSON.stringify(falseSuccessArgs)}`)
    process.exit(1)
  }
}, 2500)
