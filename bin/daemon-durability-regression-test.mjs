import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  runDaemonStartWithSupervisedNoop,
  runBoundedDaemonStartTransition,
} from '../cli/lib/daemon-supervision-transition.mjs'
import {
  createSafeIpcSender,
} from './fleet-jsonl-ingester.mjs'
import {
  createJsonlIngestor,
} from '../daemon/jsonl-ingestor.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const daemonSource = readFileSync(join(here, 'fleet-daemon.mjs'), 'utf8')
const serverSource = readFileSync(join(here, '..', 'server', 'unified-server.mjs'), 'utf8')
const ingesterSource = readFileSync(join(here, 'fleet-jsonl-ingester.mjs'), 'utf8')
const jsonlIngestorSource = readFileSync(join(here, '..', 'daemon', 'jsonl-ingestor.mjs'), 'utf8')
const cliSource = readFileSync(join(here, '..', 'cli', 'tlda.mjs'), 'utf8')
const transitionSource = readFileSync(join(here, '..', 'cli', 'lib', 'daemon-supervision-transition.mjs'), 'utf8')

test('JSONL ingester IPC send contains EPIPE and closed-channel failures', () => {
  const errors = []
  const processLike = {
    connected: true,
    send() {
      const e = new Error('broken pipe')
      e.code = 'EPIPE'
      throw e
    },
  }
  const send = createSafeIpcSender(processLike, { onClosed: e => errors.push(e.code) })

  assert.equal(send({ type: 'batch' }), false)
  assert.deepEqual(errors, ['EPIPE'])
  assert.equal(send({ type: 'batch' }), false)
  assert.deepEqual(errors, ['EPIPE'])
})

test('JSONL ingester IPC send rethrows unexpected failures', () => {
  const processLike = {
    connected: true,
    send() {
      const e = new Error('unexpected')
      e.code = 'EBADF'
      throw e
    },
  }
  const send = createSafeIpcSender(processLike)
  assert.throws(() => send({ type: 'batch' }), /unexpected/)
})

test('JSONL ingester IPC sender closes on disconnected process state', () => {
  const errors = []
  const processLike = {
    connected: false,
    send() {
      assert.fail('send must not be called when disconnected')
    },
  }
  const send = createSafeIpcSender(processLike, { onClosed: e => errors.push(e.code) })

  assert.equal(send({ type: 'batch' }), false)
  assert.deepEqual(errors, ['ERR_IPC_CHANNEL_CLOSED'])
  assert.equal(send({ type: 'batch' }), false)
  assert.deepEqual(errors, ['ERR_IPC_CHANNEL_CLOSED'])
})

test('closed JSONL child IPC exits instead of remaining live and mute', () => {
  assert.match(ingesterSource, /parent IPC closed:.*exiting for resync/)
  assert.match(ingesterSource, /onClosed:[\s\S]*process\.exit\(1\)/)
})

test('daemon treats stale JSONL child IPC as an ingester-down lifecycle event', () => {
  assert.match(jsonlIngestorSource, /function sendJsonlIngesterMessage\(msg\)/)
  assert.match(jsonlIngestorSource, /child\.connected === false \|\| child\.killed/)
  assert.match(jsonlIngestorSource, /handleJsonlIngesterExit\('ipc-closed', null\)/)
  assert.match(jsonlIngestorSource, /JSONL ingester child IPC closed/)
  assert.match(jsonlIngestorSource, /child\.on\('disconnect'/)
  assert.match(jsonlIngestorSource, /child\.on\('close'/)
  assert.match(jsonlIngestorSource, /JSONL ingester stderr/)
  assert.match(jsonlIngestorSource, /activityDeliveryCounters\?\.record\?\.\('jsonlIngesterDown'/)
})

test('JSONL ingestor respawns after parent-side EPIPE on stale child handle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-jsonl-ingestor-stale-ipc-'))
  try {
    const configDir = join(dir, 'config')
    const projectsDir = join(dir, 'projects')
    const jsonlPath = join(dir, 'rollout-stale-ipc.jsonl')
    writeFileSync(jsonlPath, '')
    const children = []
    const logs = []
    const counters = []
    const agent = {
      id: 'fleet:staleipc',
      friendly_name: 'stale-ipc',
      dead: false,
      human: false,
      machine_id: 'mini',
      env_name: 'test',
      daemon_key: 'mini:test',
      cwd: dir,
      session_id: 'rollout-stale-ipc',
      session_ids: ['rollout-stale-ipc'],
    }
    const ingestor = createJsonlIngestor({
      configDir,
      cursorsFile: join(configDir, 'cursors.json'),
      projectsDir,
      daemonDir: here,
      log: {
        info: message => logs.push(['info', message]),
        warn: message => logs.push(['warn', message]),
        error: message => logs.push(['error', message]),
      },
      sendMsg: () => true,
      sendMsgWithReply: async () => ({}),
      isConnected: () => true,
      isServerReady: () => true,
      getAgents: () => [agent],
      listSessions: async () => ({ sessions: [] }),
      selectAgentKind: async () => 'codex',
      harnessAdapters: {
        codex: {
          activity: {
            kind: 'codex',
            resolveJsonl: async () => jsonlPath,
            terminalChat: false,
            backfillSearch: false,
          },
        },
      },
      permissionLedger: { setSessionSync: () => {} },
      bufferActivity: () => true,
      extractActivityEvents: () => [],
      activityDeliveryCounters: { record: (...args) => counters.push(args) },
      machineId: 'mini',
      envName: 'test',
      daemonKey: 'mini:test',
      forkProcess: () => {
        const child = new EventEmitter()
        child.connected = true
        child.killed = false
        child.sent = []
        child.send = msg => {
          child.sent.push(msg)
          return true
        }
        child.kill = () => {
          child.killed = true
          child.connected = false
        }
        children.push(child)
        return child
      },
      watchDir: () => ({ on: () => ({ on: () => ({ on: () => {} }) }), close: () => {} }),
      nowMs: () => 1000 + children.length,
      random: () => 0.25,
    })

    await ingestor.sync([agent])
    assert.equal(children.length, 1)
    assert.equal(children[0].sent[0]?.type, 'watch')

    const e = new Error('write EPIPE')
    e.code = 'EPIPE'
    children[0].emit('error', e)

    assert.ok(logs.some(([, message]) => /JSONL ingester child IPC closed: write EPIPE/.test(message)))
    assert.ok(counters.some(([stage]) => stage === 'jsonlIngesterDown'))

    await ingestor.sync([agent])
    assert.equal(children.length, 2)
    assert.equal(children[1].sent[0]?.type, 'watch')
    ingestor.shutdown()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('daemon records drop and websocket lifecycle counters', () => {
  const counterSource = readFileSync(join(here, '..', 'shared', 'activity-delivery-counters.mjs'), 'utf8')
  const deliverySource = readFileSync(join(here, '..', 'daemon', 'delivery-runtime.mjs'), 'utf8')
  assert.match(counterSource, /DAEMON_DROPPED: 'daemonDropped'/)
  assert.match(counterSource, /DAEMON_WS_CONNECTED: 'daemonWsConnected'/)
  assert.match(counterSource, /DAEMON_WS_DISCONNECTED: 'daemonWsDisconnected'/)
  assert.match(counterSource, /JSONL_INGESTER_DOWN: 'jsonlIngesterDown'/)
  assert.match(deliverySource, /recordActivityDelivery\('daemonDropped', message\)/)
  assert.match(daemonSource, /ACTIVITY_DELIVERY_STAGES\.DAEMON_WS_CONNECTED/)
  assert.match(daemonSource, /ACTIVITY_DELIVERY_STAGES\.DAEMON_WS_DISCONNECTED/)
  assert.match(daemonSource, /activityDeliveryCounters: daemonActivityDeliveryCounters/)
})

test('daemon welcome carries no roster and restores local-binding liveness plus JSONL lifecycle', () => {
  const welcomeHandler = daemonSource.match(/if \(msg\.type === 'daemon-welcome'\) \{([\s\S]*?)\n  \}\n  if \(msg\.type === 'agent-status-events'\)/)?.[1] || ''
  const welcomePayload = serverSource.match(/type: 'daemon-welcome',([\s\S]*?)projects: projectsForDaemon\(\)/)?.[1] || ''
  assert.ok(welcomeHandler)
  assert.doesNotMatch(welcomeHandler, /msg\.agents|reconcileRoster|agentStatus\.start/)
  assert.match(welcomeHandler, /agentLiveness\.start\(\)/)
  assert.match(welcomeHandler, /jsonlIngestor\.startOwnerHarvester\(\)/)
  assert.match(welcomeHandler, /reconcileJsonlProcessBindings\('daemon-welcome'\)/)
  assert.match(welcomeHandler, /jsonlIngestor\.resumeAfterServerReady\(\)/)
  assert.doesNotMatch(welcomePayload, /agents|agent_status/)
  assert.match(daemonSource, /getAgents: \(\) => livenessAgentsFromProcessBindings\(permissionLedger\.listProcessBindings\(\)/)
  assert.match(daemonSource, /getAgents: currentJsonlBindingAgents/)
})

test('fleet daemon does not intentionally exit on SIGPIPE', () => {
  assert.match(daemonSource, /process\.on\('SIGPIPE', \(\) => \{\s*log\.warn\('received SIGPIPE/)
  const exitSignalList = daemonSource.match(/for \(const sig of \[(.*?)\]\)/s)?.[1] || ''
  assert.doesNotMatch(exitSignalList, /SIGPIPE/)
})

test('bounded transition reports accepted launchd pending without fallback', async () => {
  const calls = []
  const result = await runBoundedDaemonStartTransition({
    existingPid: 111,
    log: event => calls.push(['log', event]),
    writePlist: async () => calls.push(['writePlist']),
    bootstrap: async () => calls.push(['bootstrap']),
    stopExisting: async pid => calls.push(['stopExisting', pid]),
    waitSupervised: async ({ previousPid, timeoutMs }) => {
      calls.push(['waitSupervised', previousPid, timeoutMs])
      return null
    },
    verifyTargetDaemon: async pid => calls.push(['verifyTargetDaemon', pid]),
    supervisedTimeoutMs: 25,
  })

  assert.deepEqual(result, {
    mode: 'launchd-pending',
    pid: null,
    pending: true,
    reason: 'supervised launchd did not become ready within 25ms',
  })
  assert.deepEqual(calls.map(call => call[0]), ['log', 'writePlist', 'stopExisting', 'bootstrap', 'waitSupervised'])
})

test('daemon start keeps already-supervised daemon as supervised noop', async () => {
  const result = await runDaemonStartWithSupervisedNoop({
    existingPid: 222,
    getLaunchdPid: async () => 222,
    launchdOwnsExisting: async (launchdPid, daemonPid) => launchdPid === daemonPid,
    verifyTargetDaemon: async (pid, opts) => {
      assert.equal(pid, 222)
      assert.deepEqual(opts, { supervised: true })
    },
    runBoundedTransition: async () => assert.fail('must not transition an already-supervised daemon'),
  })

  assert.deepEqual(result, { mode: 'already-supervised', pid: 222 })
})

test('bounded transition reports supervised-ready without fallback metadata', async () => {
  const result = await runBoundedDaemonStartTransition({
    existingPid: 111,
    writePlist: async () => {},
    bootstrap: async () => {},
    stopExisting: async () => {},
    waitSupervised: async () => 333,
    verifyTargetDaemon: async (pid, opts) => {
      assert.equal(pid, 333)
      assert.deepEqual(opts, { supervised: true })
    },
  })

  assert.deepEqual(result, { mode: 'supervised', pid: 333 })
})

test('bounded transition releases the singleton before bootstrapping launchd', async () => {
  const calls = []
  await assert.rejects(
    runBoundedDaemonStartTransition({
      existingPid: 111,
      writePlist: async () => calls.push('writePlist'),
      bootstrap: async () => {
        calls.push('bootstrap')
        throw new Error('bootstrap rejected')
      },
      stopExisting: async () => calls.push('stopExisting'),
      waitSupervised: async () => null,
      verifyTargetDaemon: async () => {},
    }),
    /bootstrap rejected/,
  )
  assert.deepEqual(calls, ['writePlist', 'stopExisting', 'bootstrap'])
})

test('daemon start code has no direct detached fallback or recovery script path', () => {
  assert.doesNotMatch(cliSource, /startDirectFleetDaemonFallback/)
  assert.doesNotMatch(cliSource, /fleet-daemon-recovery\.sh/)
  assert.doesNotMatch(cliSource, /direct fallback/)
  assert.doesNotMatch(transitionSource, /startDirectFallback|direct-fallback|fallbackTimeoutMs/)
})
