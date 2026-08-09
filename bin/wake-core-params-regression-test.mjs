#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createDaemonWakeCore } from '../daemon/wake-core.mjs'
import { runtimeStateFromProcessList } from '../agent-launch/tmux.mjs'

let receivedFacts = null
let receivedParams = null
let baseResumed = false

const wake = createDaemonWakeCore({
  store: {
    resolve: fleetId => ({
      mintId: 'mint-1',
      fleetId,
      sessionId: 'session-1',
      launchRecipe: { permissionGrant: 'old-grant' },
    }),
    updateProcessState: (mintId, processState) => ({
      mintId,
      fleetId: 'fleet:test',
      sessionId: 'session-1',
      processState,
    }),
  },
  processAlive: async () => baseResumed,
  resumeSession: async (facts, params) => {
    receivedFacts = facts
    receivedParams = params
    baseResumed = true
    return { resumed: true }
  },
})

const result = await wake({
  fleet_id: 'fleet:test',
  permissionGrant: 'wd',
  permissionSet: { operations: { read: { allow: ['.'], deny: [] }, write: { allow: ['.'], deny: [] } } },
})

assert.equal(result.ok, true)
assert.equal(result.resumed, true)
assert.equal(receivedFacts.fleetId, 'fleet:test')
assert.equal(receivedParams.permissionGrant, 'wd')
assert.deepEqual(receivedParams.permissionSet.operations.read.allow, ['.'])

const runtime = runtimeStateFromProcessList(['10'], [
  '10 1 -zsh',
  '11 10 node /opt/homebrew/bin/codex --no-alt-screen -c mcp_servers.tlda.env.FLEET_DAEMON_KEY="mini:stable"',
].join('\n'))
assert.equal(runtime.runtime, true)
assert.equal(runtime.daemonKey, 'mini:stable')

let liveDaemonKey = 'mini:stable'
let replaced = 0
let resumed = 0
const takeoverWake = createDaemonWakeCore({
  store: {
    resolve: () => ({
      mintId: 'mint-takeover',
      fleetId: 'fleet:takeover',
      sessionId: 'session-takeover',
      processState: { tmux_session: 'fleet-takeover' },
    }),
    updateProcessState: (mintId, processState) => ({ mintId, processState }),
  },
  targetDaemonKey: 'mini:testing',
  processAlive: async () => replaced === 0 || resumed > 0,
  processDaemonKey: async () => liveDaemonKey,
  replaceProcess: async () => {
    replaced += 1
    return true
  },
  resumeSession: async () => {
    resumed += 1
    return { tmux_session: 'fleet-takeover', daemon_key: 'mini:testing' }
  },
})

const takeover = await takeoverWake({
  fleet_id: 'fleet:takeover',
  takeover_existing: true,
})
assert.equal(takeover.takenOver, true)
assert.equal(replaced, 1)
assert.equal(resumed, 1)

liveDaemonKey = 'mini:testing'
replaced = 0
resumed = 0
const alreadyOwned = await takeoverWake({
  fleet_id: 'fleet:takeover',
  takeover_existing: true,
})
assert.equal(alreadyOwned.alreadyAlive, true)
assert.equal(replaced, 0)
assert.equal(resumed, 0)

let runtimeChecks = 0
let handoffResumes = 0
const handoffWake = createDaemonWakeCore({
  store: {
    resolve: () => ({
      mintId: 'mint-handoff',
      fleetId: 'fleet:handoff',
      sessionId: 'session-handoff',
      processState: { tmux_session: 'fleet-handoff', harness: 'bot' },
    }),
    updateProcessState: (mintId, processState) => ({ mintId, processState }),
  },
  processAlive: async () => {
    runtimeChecks += 1
    return runtimeChecks === 1 || runtimeChecks >= 4
  },
  resumeSession: async () => {
    handoffResumes += 1
    return { tmux_session: 'fleet-handoff', harness: 'bot' }
  },
  retryPolicy: () => ({ attempts: 4, delayMs: 1, confirmExisting: true }),
  sleep: async () => {},
})

const handoff = await handoffWake({ fleet_id: 'fleet:handoff' })
assert.equal(handoff.resumed, true)
assert.equal(handoff.alreadyAlive, undefined)
assert.equal(handoffResumes, 2)

let failedResumeAttempts = 0
const failedWake = createDaemonWakeCore({
  store: {
    resolve: () => ({ mintId: 'mint-failed', fleetId: 'fleet:failed', sessionId: 'session-failed' }),
    updateProcessState: () => assert.fail('an unverified wake must not update process state'),
  },
  processAlive: async () => false,
  resumeSession: async () => {
    failedResumeAttempts += 1
    return { tmux_session: 'fleet-failed' }
  },
  retryPolicy: () => ({ attempts: 3, delayMs: 1 }),
  sleep: async () => {},
})

await assert.rejects(
  failedWake({ fleet_id: 'fleet:failed' }),
  /wake did not produce a live runtime for mint-failed/,
)
assert.equal(failedResumeAttempts, 3)

console.log('wake core params regression: ok')
