import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJsonlIngestor } from '../daemon/jsonl-ingestor.mjs'
import { projectJsonlAgentsFromProcessBindings } from '../daemon/jsonl-local-bindings.mjs'

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
    cwd: '/Users/you/work/tlda',
    friendlyName: 'jsonl-owner',
    ...overrides,
  }
}

function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-activity-heartbeat-'))
  const configDir = join(dir, 'config')
  const projectsDir = join(dir, 'projects')
  const projectDir = join(projectsDir, '-Users-skip-work-tlda')
  const jsonlPath = join(projectDir, 'rollout-jsonl-owner.jsonl')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(jsonlPath, '{}\n', { flag: 'w' })

  const sentToChild = []
  const sentToServer = []
  const children = []
  const dirWatchers = []
  const bufferedActivity = []
  let rows = []

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
    sendMsg(message) { sentToServer.push(message); return true },
    sendMsgWithReply: async () => ({}),
    isConnected: () => true,
    isServerReady: () => true,
    getAgents: () => projectJsonlAgentsFromProcessBindings(rows, { daemonKey: 'mini:default' }),
    listSessions: async () => ({ sessions: ['fleet-jsonl-owner'] }),
    selectAgentKind: async agent => agent.runtimeKind || agent.metadata?.kind,
    harnessAdapters: {
      codex: { activity: { kind: 'codex', terminalChat: false, backfillSearch: false } },
    },
    jsonlTranscriptRoots: [projectsDir],
    permissionLedger: null,
    bufferActivity(agentId, activity) { bufferedActivity.push({ agentId, activity }) },
    extractActivityEvents() { return [] },
    machineId: 'mini',
    envName: 'default',
    daemonKey: 'mini:default',
    forkProcess,
    random: () => 0,
    watchTree: (_root, onChange) => {
      const watcher = new EventEmitter()
      watcher.close = () => {}
      watcher.onChange = onChange
      dirWatchers.push(watcher)
      return watcher
    },
  })
  return {
    ingestor,
    jsonlPath,
    sentToChild,
    sentToServer,
    children,
    bufferedActivity,
    setRows(next) { rows = next },
    sync: async () => ingestor.sync(projectJsonlAgentsFromProcessBindings(rows, { daemonKey: 'mini:default' })),
    cleanup() {
      ingestor.shutdown()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function bindOwner(harness) {
  harness.setRows([{
    id: 'fleet:jsonl-owner',
    ...fullBinding({ sessionId: 'rollout-jsonl-owner', sessionKind: 'codex', sessionPath: harness.jsonlPath }),
  }])
  await harness.sync()
  const watch = harness.sentToChild.find(message => message.type === 'watch')
  assert.ok(watch)
  return watch
}

test('activity batch sends a heartbeat for the producing agent', async () => {
  const harness = createHarness()
  try {
    const watch = await bindOwner(harness)
    harness.children[0].child.emit('message', {
      type: 'batch',
      watchId: watch.watchId,
      seq: 1,
      outputs: [
        {
          type: 'identity',
          identity: {
            marker: {
              daemon_key: 'mini:default',
              fleet_id: 'fleet:jsonl-owner',
              mint_id: 'mint-jsonl-owner',
              session_id: 'rollout-jsonl-owner',
              harness_kind: 'codex',
              model: 'gpt-test',
              cwd: '/Users/you/work/tlda',
            },
          },
        },
        { type: 'activity', events: [{ tool: 'Bash' }] },
      ],
    })
    assert.equal(
      harness.sentToServer.some(message => message.type === 'heartbeat' && message.agent === 'fleet:jsonl-owner'),
      true,
    )
    assert.equal(harness.bufferedActivity.length, 1)
  } finally {
    harness.cleanup()
  }
})

test('empty activity batch sends no heartbeat', async () => {
  const harness = createHarness()
  try {
    const watch = await bindOwner(harness)
    const before = harness.sentToServer.length
    harness.children[0].child.emit('message', {
      type: 'batch',
      watchId: watch.watchId,
      seq: 1,
      outputs: [{ type: 'activity', events: [] }],
    })
    assert.equal(
      harness.sentToServer.slice(before).some(message => message.type === 'heartbeat'),
      false,
    )
  } finally {
    harness.cleanup()
  }
})
