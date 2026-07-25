#!/usr/bin/env node
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPermissionLedger } from '../agent-launch/permission-ledger.mjs'
import { createCoalescedSyncRunner, createJsonlIngestor } from '../daemon/jsonl-ingestor.mjs'
import {
  createJsonlProcessBindingReconciler,
  jsonlProcessBindingSignature,
  projectJsonlAgentsFromProcessBindings,
} from '../daemon/jsonl-local-bindings.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function fullBinding(overrides = {}) {
  return {
    sessionId: 'rollout-jsonl-owner',
    sessionKind: 'codex',
    sessionPath: '/tmp/jsonl-owner.jsonl',
    tmuxSession: 'fleet-jsonl-owner',
    model: 'gpt-test',
    machineId: 'mini',
    envName: 'default',
    daemonKey: 'mini:default',
    terminalCapability: 'termcap-jsonl-owner',
    cwd: '/Users/skip/work/tlda',
    friendlyName: 'jsonl-owner',
    ...overrides,
  }
}

function createLedger(onProcessBindingChange = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-jsonl-local-binding-'))
  const ledger = createPermissionLedger(join(dir, 'permission-ledger.db'), { onProcessBindingChange })
  ledger.setSync('fleet:jsonl-owner', { permissionGrant: 'cwd', source: 'test' })
  return {
    ledger,
    dir,
    cleanup() {
      ledger.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function createHarness({ kind = 'codex' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-jsonl-watchers-'))
  const configDir = join(dir, 'config')
  const projectsDir = join(dir, 'projects')
  const projectDir = join(projectsDir, '-Users-skip-work-tlda')
  const jsonlPath = join(projectDir, 'rollout-jsonl-owner.jsonl')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(jsonlPath, kind === 'claude'
    ? '{"message":{"content":[{"type":"text","text":"Logged in fleet:jsonlown.\\nYour name: \\"jsonl-owner\\""}]}}\n'
    : '', { flag: 'w' })

  const sentToChild = []
  const sentToServer = []
  const children = []
  const dirWatchers = []
  let ready = true
  let rows = []
  const syncCalls = []

  function forkProcess(script, args = []) {
    assert.ok(script.endsWith('fleet-jsonl-ingester.mjs'))
    const child = new EventEmitter()
    child.send = message => sentToChild.push(message)
    child.kill = () => child.emit('exit', 0, null)
    children.push({ child, script, args })
    return child
  }

  const ingestor = createJsonlIngestor({
    configDir,
    cursorsFile: join(configDir, 'cursors.json'),
    projectsDir,
    daemonDir: here,
    log: { info() {}, warn() {}, error() {} },
    sendMsg(message) { sentToServer.push(message) },
    sendMsgWithReply() {},
    isConnected: () => true,
    isServerReady: () => ready,
    getAgents: () => projectJsonlAgentsFromProcessBindings(rows, { daemonKey: 'mini:default' }),
    listSessions: async () => ({ sessions: ['fleet-jsonl-owner'] }),
    selectAgentKind: async agent => agent.runtimeKind || agent.metadata?.kind,
    harnessAdapters: {
      codex: {
        activity: {
          kind: 'codex',
          terminalChat: false,
          backfillSearch: false,
        },
      },
      claude: {
        activity: {
          kind: 'claude',
          terminalChat: true,
          backfillSearch: false,
          usesClaudeSessionIds: true,
        },
      },
    },
    jsonlTranscriptRoots: [projectsDir],
    permissionLedger: null,
    bufferActivity() {},
    extractActivityEvents() { return [] },
    machineId: 'mini',
    envName: 'default',
    daemonKey: 'mini:default',
    forkProcess,
    watchDir: () => {
      const watcher = new EventEmitter()
      watcher.close = () => {}
      dirWatchers.push(watcher)
      return watcher
    },
    nowMs: () => 123,
    random: () => 0,
  })

  function setRows(nextRows) {
    rows = nextRows
  }

  async function sync(reason = 'test') {
    syncCalls.push(reason)
    await ingestor.sync(projectJsonlAgentsFromProcessBindings(rows, { daemonKey: 'mini:default' }))
  }

  return {
    dir,
    jsonlPath,
    sentToChild,
    sentToServer,
    children,
    dirWatchers,
    syncCalls,
    ingestor,
    setRows,
    sync,
    setReady(value) { ready = value },
    cleanup() {
      ingestor.shutdown()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function createBindingReconciler({ ledger, ingestor, daemonKey = 'mini:default' }) {
  return createJsonlProcessBindingReconciler({
    listProcessBindings: () => ledger.listProcessBindings(),
    sync: agents => ingestor.sync(agents),
    daemonKey,
    log: { info() {} },
  }).reconcile
}

function assertWatcher(harness, expected, kind = 'codex') {
  assert.equal(
    harness.ingestor.hasWatcherForAgent({ id: 'fleet:jsonl-owner' }, kind),
    expected,
    JSON.stringify(harness.sentToServer.slice(-5), null, 2),
  )
}

function assertTailCount(harness, expected) {
  assert.equal(harness.sentToChild.filter(m => m.type === 'watch').length, expected)
}

{
  const agents = projectJsonlAgentsFromProcessBindings([
    { id: 'fleet:jsonl-owner', ...fullBinding() },
    { id: 'fleet:other-env', ...fullBinding({ daemonKey: 'mini:other', tmuxSession: 'other' }) },
    { id: 'fleet:no-session', ...fullBinding({ sessionId: null }) },
  ], { daemonKey: 'mini:default' })

  assert.equal(agents.length, 1)
  assert.equal(agents[0].session_id, 'rollout-jsonl-owner')
  assert.equal(agents[0].metadata.kind, 'codex')
}

{
  const base = [{ id: 'fleet:jsonl-owner', ...fullBinding() }]
  for (const changed of [
    { friendlyName: 'renamed' },
    { model: 'different-model' },
    { terminalCapability: 'different-capability' },
  ]) {
    assert.equal(
      jsonlProcessBindingSignature(base, { daemonKey: 'mini:default' }),
      jsonlProcessBindingSignature([{ id: 'fleet:jsonl-owner', ...fullBinding(changed) }], { daemonKey: 'mini:default' }),
    )
  }
  assert.notEqual(
    jsonlProcessBindingSignature(base, { daemonKey: 'mini:default' }),
    jsonlProcessBindingSignature([{ id: 'fleet:jsonl-owner', ...fullBinding({ sessionId: 'rollout-jsonl-owner-2' }) }], { daemonKey: 'mini:default' }),
  )
}

{
  const changes = []
  const { ledger, cleanup } = createLedger(event => changes.push(event))
  try {
    ledger.setSessionSync('fleet:jsonl-owner', fullBinding())
    assert.equal(changes.length, 1)
    ledger.setSessionSync('fleet:jsonl-owner', { friendlyName: 'renamed-only' })
    ledger.setSessionSync('fleet:jsonl-owner', { lastSeen: '2026-07-21T22:00:00.000Z' })
    ledger.setSessionSync('fleet:jsonl-owner', { model: 'filled-model' })
    ledger.setSessionSync('fleet:jsonl-owner', { terminalCapability: 'filled-capability' })
    assert.equal(changes.length, 1)
    ledger.deleteSyncForTest('fleet:jsonl-owner')
    assert.equal(changes.length, 2)
    assert.equal(changes[1].deleted, true)
  } finally {
    cleanup()
  }
}

{
  const warnings = []
  const originalWarn = console.warn
  console.warn = message => warnings.push(String(message))
  const { ledger, cleanup } = createLedger(() => { throw new Error('observer exploded') })
  try {
    const row = ledger.setSessionSync('fleet:jsonl-owner', fullBinding())
    assert.equal(row.sessionId, 'rollout-jsonl-owner')
    assert.equal(ledger.get('fleet:jsonl-owner').sessionId, 'rollout-jsonl-owner')
    assert.equal(warnings.length, 1)
  } finally {
    console.warn = originalWarn
    cleanup()
  }
}

{
  const harness = createHarness()
  try {
    harness.setRows([{ id: 'fleet:jsonl-owner', ...fullBinding({ sessionPath: harness.jsonlPath }) }])
    await harness.sync('daemon-welcome')
    assertWatcher(harness, false)
    assertTailCount(harness, 1)
    assert.equal(harness.sentToChild.find(m => m.type === 'watch')?.agentId, null)
  } finally {
    harness.cleanup()
  }
}

{
  const harness = createHarness()
  try {
    const historicalPath = join(dirname(harness.jsonlPath), 'historical-session.jsonl')
    writeFileSync(historicalPath, '{"type":"assistant","message":{"content":"old"}}\n')
    harness.setRows([{ id: 'fleet:jsonl-owner', ...fullBinding({ sessionPath: harness.jsonlPath }) }])
    await harness.sync('daemon-welcome-with-history')
    assertTailCount(harness, 1)
    assert.equal(
      harness.sentToChild.some(m => m.type === 'watch' && m.jsonlPath === historicalPath),
      false,
    )
  } finally {
    harness.cleanup()
  }
}

// Marker ownership is the only JSONL ownership path. An unmarked file is
// not-yet: tail it from the beginning, emit nothing, and wait for the marker.
{
  const harness = createHarness({ kind: 'claude' })
  try {
    harness.setRows([{ id: 'fleet:jsonl-owner', ...fullBinding({
      sessionKind: 'claude',
      sessionId: 'rollout-jsonl-owner',
      sessionPath: harness.jsonlPath,
    }) }])
    await harness.sync('post-startup-new-jsonl')
    const watch = harness.sentToChild.find(message => message.type === 'watch')
    assert.equal(watch?.startOffset, 0)
    assert.equal(harness.sentToServer.length, 0)
    harness.children[0].child.emit('message', {
      type: 'batch',
      watchId: watch.watchId,
      seq: 1,
      outputs: [{
        type: 'identity',
        identity: {
          marker: {
            daemon_key: 'mini:default',
            fleet_id: 'fleet:jsonl-owner',
            mint_id: 'mint-jsonl-owner',
            session_id: 'rollout-jsonl-owner',
            harness_kind: 'claude',
            model: 'gpt-test',
            cwd: '/Users/skip/work/tlda',
          },
        },
      }],
    })
    assert.equal(harness.sentToChild.some(message => message.type === 'ack' && message.watchId === watch.watchId), true)
    assertWatcher(harness, true, 'claude')
    assert.equal(harness.sentToServer.some(message => message.type === 'activity-health' && message.state === 'ok'), true)
    harness.ingestor.saveCursors()
    const saved = JSON.parse(readFileSync(join(harness.dir, 'config', 'cursors.json'), 'utf8'))
    assert.equal(saved['rollout-jsonl-owner'].owner.state, 'mine')
    assert.equal(saved['rollout-jsonl-owner'].owner.daemon_key, 'mini:default')
  } finally {
    harness.cleanup()
  }
}

{
  const harness = createHarness({ kind: 'claude' })
  try {
    harness.setRows([{ id: 'fleet:jsonl-owner', ...fullBinding({
      sessionKind: 'claude',
      sessionId: 'rollout-jsonl-owner',
      sessionPath: harness.jsonlPath,
    }) }])
    await harness.sync('foreign-jsonl')
    const watch = harness.sentToChild.find(message => message.type === 'watch')
    harness.children[0].child.emit('message', {
      type: 'batch',
      watchId: watch.watchId,
      seq: 1,
      outputs: [{
        type: 'identity',
        identity: {
          marker: {
            daemon_key: 'mini:stable',
            fleet_id: 'fleet:jsonl-owner',
            mint_id: 'mint-jsonl-owner',
          },
        },
      }],
    })
    assert.equal(harness.sentToChild.some(message => message.type === 'stop' && message.watchId === watch.watchId), true)
    assert.equal(harness.sentToServer.some(message => message.type === 'activity-health'), false)
    harness.ingestor.saveCursors()
    const saved = JSON.parse(readFileSync(join(harness.dir, 'config', 'cursors.json'), 'utf8'))
    assert.equal(saved['rollout-jsonl-owner'].owner.state, 'ignore')
    assert.equal(saved['rollout-jsonl-owner'].owner.daemon_key, 'mini:stable')
  } finally {
    harness.cleanup()
  }
}

{
  const harness = createHarness()
  const changes = []
  const { ledger, cleanup } = createLedger(event => changes.push(event))
  try {
    const reconcile = createBindingReconciler({ ledger, ingestor: harness.ingestor })
    assertWatcher(harness, false)
    ledger.onProcessBindingChange = () => { void reconcile('permission-ledger-session-binding') }
    ledger.setSessionSync('fleet:jsonl-owner', fullBinding({ sessionPath: harness.jsonlPath }))
    await new Promise(resolve => setImmediate(resolve))
    assertWatcher(harness, false)
    assertTailCount(harness, 1)
    ledger.setSessionSync('fleet:jsonl-owner', { terminalCapability: 'changed-only' })
    await new Promise(resolve => setImmediate(resolve))
    assertTailCount(harness, 1)
  } finally {
    cleanup()
    harness.cleanup()
  }
}

{
  const harness = createHarness()
  let deleteReconcilePromise = Promise.resolve()
  const { ledger, cleanup } = createLedger()
  try {
    const reconcile = createBindingReconciler({ ledger, ingestor: harness.ingestor })
    ledger.onProcessBindingChange = () => {
      deleteReconcilePromise = reconcile('permission-ledger-delete')
    }
    ledger.setSessionSync('fleet:jsonl-owner', fullBinding({ sessionPath: harness.jsonlPath }))
    await reconcile('attach')
    assertTailCount(harness, 1)
    assertWatcher(harness, false)
    await ledger.delete('fleet:jsonl-owner')
    await deleteReconcilePromise
    assertWatcher(harness, false)
    assertTailCount(harness, 1)
    assert.equal(harness.sentToChild.some(m => m.type === 'stop'), false)
  } finally {
    cleanup()
    harness.cleanup()
  }
}

{
  const harness = createHarness()
  try {
    harness.setRows([{ id: 'fleet:jsonl-owner', ...fullBinding({ sessionPath: harness.jsonlPath }) }])
    await harness.sync('attach')
    harness.setReady(false)
    const child = harness.children.find(Boolean).child
    child.emit('exit', 1, null)
    assertWatcher(harness, false)
    harness.setReady(true)
    assert.equal(harness.ingestor.resumeAfterServerReady(), true)
    await new Promise(resolve => setImmediate(resolve))
    assertTailCount(harness, 2)
    assertWatcher(harness, false)
  } finally {
    harness.cleanup()
  }
}

{
  let releaseA
  const calls = []
  const runner = createCoalescedSyncRunner(async value => {
    calls.push(value)
    if (value === 'A') await new Promise(resolve => { releaseA = resolve })
    if (value === 'B') throw new Error('B failed after queue')
  })
  const syncA = runner.sync('A')
  await new Promise(resolve => setImmediate(resolve))
  const syncB = runner.sync('B')
  releaseA()
  await assert.rejects(syncA, /B failed after queue/)
  await assert.rejects(syncB, /B failed after queue/)
  assert.deepEqual(calls, ['A', 'B'])
}

{
  let calls = 0
  const ingestor = {
    async sync() {
      calls += 1
      if (calls === 1) throw new Error('sync failed')
    },
  }
  const { ledger, cleanup } = createLedger()
  try {
    ledger.setSessionSync('fleet:jsonl-owner', fullBinding())
    const reconcile = createBindingReconciler({ ledger, ingestor })
    await assert.rejects(() => reconcile('first'), /sync failed/)
    assert.equal(await reconcile('welcome-retry'), true)
    assert.equal(calls, 2)
  } finally {
    cleanup()
  }
}

console.log('jsonl local binding authority tests passed')
