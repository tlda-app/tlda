import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { sendActivityEvents } from '../agent-runtime/activity-send.mjs'
import { DaemonDeliveryRuntime } from '../daemon/delivery-runtime.mjs'
import { createHarnessRuntime } from '../daemon/harness-runtime.mjs'
import { DaemonOutbox } from '../daemon/outbox.mjs'
import { sessionIdentitySeatEvent } from '../daemon/jsonl-ingestor.mjs'
import { buildDaemonActivityRecord } from '../server/lib/daemon-activity-ingest.mjs'
import { FleetStore } from '../server/lib/fleet-store.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-activity-producer-'))
const outboxPath = path.join(dir, 'daemon-outbox.db')
const fleetDbPath = path.join(dir, 'fleet.db')
let outbox = null
let store = null

try {
  const daemonIdentity = { machineId: 'mini', envName: 'default', daemonKey: 'mini:default' }
  const agent = {
    id: 'fleet:aaaa1111',
    friendly_name: 'activity-producer-test',
    human: false,
    dead: false,
    machine_id: 'mini',
    env_name: 'default',
    daemon_key: 'mini:default',
    session_id: 'rollout-local-identity',
    session_ids: ['rollout-local-identity'],
    cwd: dir,
    metadata: { kind: 'codex', model: 'gpt-test' },
  }

  let livePaneCalls = 0
  const harnessRuntime = createHarnessRuntime({
    log: { warn() {}, error() {} },
    execFileImpl: (_cmd, _args, _opts, cb) => {
      livePaneCalls += 1
      cb(new Error('live pane lookup must not run'))
    },
  })
  assert.equal(Object.hasOwn(harnessRuntime.harnessForAgent(agent).activity, 'resolve' + 'Jsonl'), false)
  assert.equal(livePaneCalls, 0)

  const seatEvent = sessionIdentitySeatEvent({
    fleet_id: agent.id,
    session_id: agent.session_id,
    harness_kind: 'codex',
    model: 'gpt-test',
    cwd: dir,
  }, daemonIdentity)
  assert.equal(seatEvent.agent_id, agent.id)
  assert.equal(seatEvent.session_id, agent.session_id)
  assert.equal(seatEvent.daemon_key, daemonIdentity.daemonKey)
  assert(!Object.hasOwn(seatEvent, 'tmux_session'))

  outbox = new DaemonOutbox(outboxPath)
  const sent = []
  const delivery = new DaemonDeliveryRuntime({
    outbox,
    send: msg => { sent.push(msg); return true },
    isConnected: () => false,
    isReady: () => false,
  })
  assert.equal(sendActivityEvents(agent.id, [{
    tool: 'inbox',
    arg: 'current-task',
    input: { view: 'current-task' },
    ts: '2026-07-21T00:00:01.000Z',
  }], msg => delivery.send(msg)), true)
  assert.equal(sent.length, 0)
  const pending = outbox.pending(10)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].type, 'activity-event')
  assert.equal(pending[0].payload.agent_id, agent.id)

  store = new FleetStore(fleetDbPath, { taskDoc: false })
  await store.upsertAgent({
    id: agent.id,
    friendly_name: agent.friendly_name,
    labels: [],
    registered_at: '2026-07-21T00:00:00.000Z',
    last_seen: '2026-07-21T00:00:00.000Z',
    dead: false,
    human: false,
    is_manager: false,
    metadata: { kind: 'codex', model: 'gpt-test' },
  })
  await store.share(buildDaemonActivityRecord(pending[0].payload))
  const history = await store.buildChatHistoryResponse({ agents: [agent.id], limit: 10 })
  assert.equal(history.events.length, 1)
  assert.equal(history.events[0].event_type, 'activity')
  assert.equal(history.events[0].from, agent.id)
  assert.equal(history.events[0].text, 'inbox')

  delivery.dispose()
  console.log('activity-producer-watch-authority-test: ok')
} finally {
  outbox?.close?.()
  store?.close?.()
  fs.rmSync(dir, { recursive: true, force: true })
}
