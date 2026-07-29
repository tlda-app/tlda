#!/usr/bin/env node
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

function createHarness({ kind = 'codex', permissionLedger = null, resolveMintFacts = null, recordMintMarker = null, jsonlFileName = 'rollout-jsonl-owner.jsonl', jsonlTailIdleMs = 10 * 60 * 1000, initialCursors = null, sendMsgWithReply = async () => ({}) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-jsonl-watchers-'))
  const configDir = join(dir, 'config')
  const projectsDir = join(dir, 'projects')
  const projectDir = join(projectsDir, '-Users-skip-work-tlda')
  const jsonlPath = join(projectDir, jsonlFileName)
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(jsonlPath, kind === 'claude'
    ? '{"message":{"content":[{"type":"text","text":"Logged in fleet:jsonlown.\\nYour name: \\"jsonl-owner\\""}]}}\n'
    : '', { flag: 'w' })
  if (initialCursors) {
    mkdirSync(configDir, { recursive: true })
    const inode = statSync(jsonlPath).ino
    const cursors = Object.fromEntries(Object.entries(initialCursors).map(([id, cursor]) => [
      id,
      { inode, ...cursor },
    ]))
    writeFileSync(join(configDir, 'cursors.json'), JSON.stringify(cursors))
  }

  const sentToChild = []
  const sentToServer = []
  const children = []
  const dirWatchers = []
  const bufferedActivity = []
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
    sendMsgWithReply,
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
    permissionLedger,
    recordMintMarker,
    resolveMintFacts,
    bufferActivity(agentId, activity) { bufferedActivity.push({ agentId, activity }) },
    extractActivityEvents() { return [] },
    machineId: 'mini',
    envName: 'default',
    daemonKey: 'mini:default',
    forkProcess,
    watchTree: (_root, onChange) => {
      const watcher = new EventEmitter()
      watcher.close = () => {}
      watcher.onChange = onChange
      dirWatchers.push(watcher)
      return watcher
    },
    jsonlTailIdleMs,
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
    bufferedActivity,
    children,
    dirWatchers,
    syncCalls,
    ingestor,
    setRows,
    sync,
    async notifyChange(changedPath = jsonlPath) {
      dirWatchers[0].onChange('change', changedPath.slice(projectsDir.length + 1))
      await wait(75)
    },
    setReady(value) { ready = value },
    cleanup() {
      ingestor.shutdown()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function wait(ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
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
  const parentThreadId = '019fa554-0000-7000-8000-000000000010'
  const childThreadId = '019fa554-0000-7000-8000-000000000011'
  const observed = []
  const harness = createHarness({
    jsonlFileName: `rollout-2026-07-28T15-00-00-${childThreadId}.jsonl`,
    initialCursors: {
      [`rollout-2026-07-28T14-00-00-${parentThreadId}`]: {
        offset: 0,
        owner: {
          state: 'mine',
          daemon_key: 'mini:default',
          fleet_id: 'fleet:jsonl-owner',
        },
      },
    },
    sendMsgWithReply: async message => {
      observed.push(message)
      return {
        ok: true,
        agent: {
          id: 'fleet:native-child',
          parent_agent_id: 'fleet:jsonl-owner',
          friendly_name: 'jsonl-owner:worker',
        },
      }
    },
  })
  try {
    writeFileSync(harness.jsonlPath, `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: childThreadId,
        parent_thread_id: parentThreadId,
        thread_source: 'subagent',
        agent_nickname: 'worker',
      },
    })}\n{}\n`)
    harness.setRows([])
    await harness.sync('native-subagent-discovery')
    assert.equal(observed.length, 1)
    assert.equal(observed[0].type, 'subagent-observed')
    assert.equal(observed[0].parent_agent_id, 'fleet:jsonl-owner')
    assert.equal(observed[0].child_name, 'worker')
    assert.match(observed[0].operation_id, /^subagent-observed:[a-f0-9]{64}$/)
    const watch = harness.sentToChild.find(message => message.type === 'watch')
    assert.equal(watch.agentId, 'fleet:native-child')

    await harness.sync('native-subagent-rediscovery')
    assert.equal(observed.length, 1)
  } finally {
    harness.cleanup()
  }
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
  const rows = [{ id: 'fleet:jsonl-owner', ...fullBinding() }]
  let syncCount = 0
  const reconciler = createJsonlProcessBindingReconciler({
    listProcessBindings: () => rows,
    sync: async () => { syncCount++ },
    daemonKey: 'mini:default',
    log: { info() {} },
  })
  await reconciler.reconcile('initial')
  await reconciler.reconcile('unchanged')
  assert.equal(syncCount, 1)
  reconciler.invalidate()
  await reconciler.reconcile('after-watcher-teardown')
  assert.equal(syncCount, 2)
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
  const harness = createHarness({ jsonlTailIdleMs: 20 })
  try {
    writeFileSync(harness.jsonlPath, '{}\n')
    harness.setRows([])
    await harness.sync('initial-unowned-jsonl')
    const firstWatch = harness.sentToChild.find(message => message.type === 'watch')
    assert.ok(firstWatch)
    const firstSize = statSync(harness.jsonlPath).size
    harness.children[0].child.emit('message', {
      type: 'flush',
      watchId: firstWatch.watchId,
      offset: firstSize,
    })
    await wait(40)
    assert.equal(
      harness.sentToChild.some(message => message.type === 'stop' && message.watchId === firstWatch.watchId),
      true,
    )

    appendFileSync(harness.jsonlPath, '{}\n')
    await harness.notifyChange()
    const watches = harness.sentToChild.filter(message => message.type === 'watch')
    assert.equal(watches.length, 2)
    assert.equal(watches[1].startOffset, firstSize)
  } finally {
    harness.cleanup()
  }
}

{
  const sessionUuid = '019fa554-0000-7000-8000-000000000001'
  const recordedMarkers = []
  let localBinding = null
  const permissionLedger = {
    get: () => localBinding,
    setSessionSync: (_agentId, binding) => { localBinding = binding },
  }
  const harness = createHarness({
    jsonlFileName: `rollout-2026-07-27T17-00-00-${sessionUuid}.jsonl`,
    permissionLedger,
    recordMintMarker: marker => recordedMarkers.push(marker),
    resolveMintFacts: marker => marker.mint_id === 'mint-jsonl-owner'
      ? {
          fleetId: 'fleet:jsonl-owner',
          friendlyName: 'jsonl-owner',
          sessionId: sessionUuid,
          sessionPath: harness.jsonlPath,
          processState: {
            harness: 'codex',
            model: 'gpt-from-mint',
            tmux_session: 'fleet-jsonl-owner',
            cwd: '/Users/skip/work/tlda',
          },
        }
      : null,
  })
  try {
    harness.setRows([])
    await harness.sync('initial-empty-root')
    writeFileSync(harness.jsonlPath, '{"type":"session_meta","payload":{"thread_source":"user"}}\n')
    await harness.notifyChange()
    const watch = harness.sentToChild.find(message => message.type === 'watch')
    harness.children[0].child.emit('message', {
      type: 'batch',
      watchId: watch.watchId,
      seq: 1,
      outputs: [{
        type: 'identity',
        identity: {
          marker: {
            daemon_key: 'mini:default',
            machine_id: 'mini',
            env_name: 'default',
            fleet_id: 'fleet:jsonl-owner',
            mint_id: 'mint-jsonl-owner',
            harness_kind: 'codex',
            cwd: '/Users/skip/work/tlda',
          },
        },
      }],
    })
    assert.equal(harness.sentToServer.some(message =>
      message.type === 'agent-route'
    ), false)
    assert.equal(permissionLedger.get('fleet:jsonl-owner').sessionId, sessionUuid)
    assert.equal(recordedMarkers[0].session_id, sessionUuid)
  } finally {
    harness.cleanup()
  }
}

{
  const sessionUuid = '019fa554-0000-7000-8000-000000000002'
  const harness = createHarness({
    jsonlFileName: `rollout-2026-07-27T17-00-01-${sessionUuid}.jsonl`,
    permissionLedger: { setSessionSync() {} },
    resolveMintFacts: () => ({
      processState: { model: 'gpt-from-mint' },
      launchRecipe: { modelSpec: { id: 'gpt-from-launch-spec' }, model: 'launch-alias' },
    }),
  })
  try {
    harness.setRows([])
    await harness.sync('initial-empty-root')
    writeFileSync(harness.jsonlPath, '{"type":"session_meta","payload":{"thread_source":"user"}}\n')
    await harness.notifyChange()
    const watch = harness.sentToChild.find(message => message.type === 'watch')
    harness.children[0].child.emit('message', {
      type: 'batch',
      watchId: watch.watchId,
      seq: 1,
      outputs: [{
        type: 'identity',
        identity: {
          marker: {
            daemon_key: 'mini:default',
            machine_id: 'mini',
            env_name: 'default',
            fleet_id: 'fleet:jsonl-owner',
            mint_id: 'mint-jsonl-owner',
            harness_kind: 'codex',
            model: 'gpt-from-marker',
            cwd: '/Users/skip/work/tlda',
          },
        },
      }],
    })
    assert.equal(harness.sentToServer.some(message => message.type === 'agent-route'), false)
  } finally {
    harness.cleanup()
  }
}

{
  const sessionUuid = '019fa554-0000-7000-8000-000000000003'
  const harness = createHarness({
    jsonlFileName: `rollout-2026-07-27T17-00-02-${sessionUuid}.jsonl`,
    permissionLedger: { setSessionSync() {} },
    resolveMintFacts: () => null,
  })
  try {
    harness.setRows([])
    await harness.sync('initial-empty-root')
    writeFileSync(harness.jsonlPath, '{"type":"session_meta","payload":{"thread_source":"user"}}\n')
    await harness.notifyChange()
    const watch = harness.sentToChild.find(message => message.type === 'watch')
    harness.children[0].child.emit('message', {
      type: 'batch',
      watchId: watch.watchId,
      seq: 1,
      outputs: [{
        type: 'identity',
        identity: {
          marker: {
            daemon_key: 'mini:default',
            machine_id: 'mini',
            env_name: 'default',
            fleet_id: 'fleet:jsonl-owner',
            mint_id: 'mint-jsonl-owner',
            harness_kind: 'codex',
            cwd: '/Users/skip/work/tlda',
          },
        },
      }],
    })
    assert.equal(harness.sentToServer.some(message => message.type === 'agent-route'), false)
  } finally {
    harness.cleanup()
  }
}

{
  const calls = []
  const harness = createHarness({
    jsonlFileName: 'rollout-2026-07-27T16-46-08-019fa553-eb8e-7d41-9ea8-9c71c3bab5f4.jsonl',
    permissionLedger: {
      setSessionSync() {
        calls.push('setSessionSync')
        throw new Error('forced ledger write failure')
      },
    },
  })
  try {
    harness.setRows([])
    await harness.sync('initial-empty-root')
    writeFileSync(harness.jsonlPath, '{"type":"session_meta","payload":{"thread_source":"user"}}\n')
    await harness.notifyChange()
    const watch = harness.sentToChild.find(message => message.type === 'watch')
    harness.children[0].child.emit('message', {
      type: 'batch',
      watchId: watch.watchId,
      seq: 1,
      outputs: [{
        type: 'identity',
        identity: {
          marker: {
            daemon_key: 'mini:default',
            machine_id: 'mini',
            env_name: 'default',
            fleet_id: 'fleet:jsonl-owner',
            mint_id: 'mint-jsonl-owner',
            harness_kind: 'codex',
            model: 'gpt-test',
            cwd: '/Users/skip/work/tlda',
          },
        },
      }],
    })
    assert.equal(calls.length >= 1, true)
    assert.equal(harness.sentToServer.some(message =>
      message.type === 'daemon-warning' &&
      message.warning === 'daemon-ledger-session-identity-write-failed' &&
      message.fleet_id === 'fleet:jsonl-owner'
    ), true)
    assert.equal(harness.sentToServer.some(message => message.type === 'agent-route'), false)
  } finally {
    harness.cleanup()
  }
}

{
  const { ledger, cleanup } = createLedger()
  const sessionUuid = '019fa553-eb8e-7d41-9ea8-9c71c3bab5f4'
  const rolloutSession = `rollout-2026-07-27T16-46-08-${sessionUuid}`
  try {
    ledger.setSessionSync('fleet:jsonl-owner', fullBinding({
      sessionId: rolloutSession,
      envName: 'stable',
      daemonKey: 'mini:stable',
      machineId: 'mini',
    }))
    const row = ledger.setSessionSync('fleet:jsonl-owner', {
      sessionId: sessionUuid,
      sessionKind: 'codex',
      sessionPath: '/tmp/jsonl-owner.jsonl',
      tmuxSession: 'fleet-jsonl-owner',
      envName: 'testing',
      daemonKey: 'mini:testing',
      machineId: 'air',
    })
    assert.equal(row.sessionId, sessionUuid)
    assert.equal(row.envName, 'stable')
    assert.equal(row.daemonKey, 'mini:stable')
    assert.equal(row.machineId, 'mini')
  } finally {
    cleanup()
  }
}

{
  const harness = createHarness()
  try {
    harness.setRows([{ id: 'fleet:jsonl-owner', ...fullBinding({ sessionPath: harness.jsonlPath }) }])
    await harness.sync('daemon-welcome')
    assertWatcher(harness, false)
    assertTailCount(harness, 0)
  } finally {
    harness.cleanup()
  }
}

{
  const harness = createHarness()
  try {
    harness.setRows([])
    await harness.sync('initial-empty-root')
    assertTailCount(harness, 0)
    const latePath = join(dirname(harness.jsonlPath), 'rollout-late-unknown.jsonl')
    writeFileSync(latePath, '{}\n')
    harness.dirWatchers[0].onChange('change', latePath.slice(join(harness.dir, 'projects').length + 1))
    await wait(75)
    const lateWatch = harness.sentToChild.find(message => message.type === 'watch' && message.jsonlPath === latePath)
    assert.ok(lateWatch, JSON.stringify(harness.sentToChild, null, 2))
    assert.equal(lateWatch.agentId, null)
    assert.equal(lateWatch.startOffset, 0)
    harness.children[0].child.emit('message', {
      type: 'batch',
      watchId: lateWatch.watchId,
      seq: 1,
      outputs: [
        {
          type: 'identity',
          identity: {
            marker: {
              daemon_key: 'mini:default',
              fleet_id: 'fleet:lateunknown',
              mint_id: 'mint-late-unknown',
              session_id: 'rollout-late-unknown',
              harness_kind: 'codex',
              model: 'gpt-test',
              cwd: '/Users/skip/work/tlda',
            },
          },
        },
        {
          type: 'activity',
          events: [{ kind: 'turn', timestamp: '2026-07-25T22:00:00.000Z' }],
        },
      ],
    })
    assert.equal(harness.ingestor.hasWatcherForAgent({ id: 'fleet:lateunknown' }, 'codex'), true)
    assert.equal(harness.bufferedActivity.length, 1)
    assert.equal(harness.bufferedActivity[0].agentId, 'fleet:lateunknown')
    assert.equal(
      harness.sentToChild.some(message => message.type === 'update' && message.watchId === lateWatch.watchId && message.agentId === 'fleet:lateunknown'),
      true,
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
  const harness = createHarness({
    kind: 'claude',
    initialCursors: {
      'rollout-jsonl-owner': {
        offset: 0,
        owner: {
          state: 'mine',
          daemon_key: 'mini:default',
          fleet_id: 'fleet:jsonl-owner',
        },
      },
    },
  })
  try {
    harness.setRows([{ id: 'fleet:jsonl-owner', ...fullBinding({
      sessionKind: 'claude',
      sessionId: 'rollout-jsonl-owner',
      sessionPath: harness.jsonlPath,
    }) }])
    await harness.sync('existing-owner')
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
            mint_id: 'historical-marker',
          },
        },
      }],
    })
    assert.equal(harness.sentToChild.some(message => message.type === 'stop' && message.watchId === watch.watchId), false)
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
    assertTailCount(harness, 0)
    ledger.setSessionSync('fleet:jsonl-owner', { terminalCapability: 'changed-only' })
    await new Promise(resolve => setImmediate(resolve))
    assertTailCount(harness, 0)
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
    writeFileSync(harness.jsonlPath, '{}\n')
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
    writeFileSync(harness.jsonlPath, '{}\n')
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
