// Death ends every subscription including the mandatory slots; a reanimated
// agent must be addressable again without anyone re-adding rows by hand.
// Measured 2026-09-21: a reanimated PM had zero live subscriptions, so chat to
// it resolved no direct match and the send path crashed dereferencing a null
// deliveryDecision instead of recording `no_direct_subscription`. Measured the
// same night on skip-math-team-sol: killed, then revived through a path that
// cleared `dead` without markAlive at all — zero live subscriptions while
// `reanimate` refused `not dead`.
//
// Three halves, matching the three halves of the fix:
// 1. `markAlive` reseeds both mandatory slots (`to:me` + `to:my_labels`).
// 2. A dead→live revival through upsertAgent (register/login) reseeds the same
//    two slots — the path that produced the observed not-dead/zero-row state.
// 3. A subscription-less recipient never crashes the send path — the delivery
//    layer reports `no_direct_subscription`, which is what the entry already
//    carries when deliveryDecision is null.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { FleetStore } from './fleet-store.mjs'
import { removeTempDir } from './test-support/remove-temp-dir.mjs'

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-reanimate-messaging-'))
  const store = new FleetStore(join(dir, 'fleet.db'))
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('death then markAlive restores both mandatory slots and delivers', () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender' })
    store.upsertAgent({ id: 'fleet:revived', friendly_name: 'revived' })
    store.ensureSubscription({
      owner: 'fleet:revived', query: 'to:me',
      notificationPolicy: 'immediate', mandatory: true,
    })

    // Positive control: the slot delivers before death.
    assert.ok(
      store.resolveSubscriptionDeliveries('fleet:sender', 'fleet:revived', 'chat')
        .some(m => m.direct && m.query === 'to:me'),
      'direct slot delivers before death',
    )

    store.markDead('fleet:revived')
    assert.equal(store.getSubscriptionsByOwner('fleet:revived').length, 0,
      'death ends the direct slot — without this the test below passes on the old row')

    store.markAlive('fleet:revived')

    const live = store.getSubscriptionsByOwner('fleet:revived')
    assert.deepEqual(live.map(r => r.query).sort(), ['to:me', 'to:my_labels'],
      'reanimate restores both mandatory slots, exactly once each')
    assert.equal(live.find(r => r.query === 'to:me').notification_policy, 'immediate')

    assert.ok(
      store.resolveSubscriptionDeliveries('fleet:sender', 'fleet:revived', 'chat')
        .some(m => m.direct && m.query === 'to:me'),
      'addressed chat resolves a direct delivery after reanimate',
    )
  } finally {
    cleanup()
  }
})

test('markAlive preserves death semantics and revives the full mandatory pair', () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsertAgent({ id: 'fleet:revived', friendly_name: 'revived' })
    store.ensureSubscription({
      owner: 'fleet:revived', query: 'to:me',
      notificationPolicy: 'immediate', mandatory: true,
    })
    store.ensureSubscription({
      owner: 'fleet:revived', query: 'to:my_labels',
      notificationPolicy: 'immediate', mandatory: true,
    })

    store.markDead('fleet:revived')
    assert.equal(store.getSubscriptionsByOwner('fleet:revived').length, 0,
      'death still ends every subscription including the group slot')

    store.markAlive('fleet:revived')
    const queries = store.getSubscriptionsByOwner('fleet:revived').map(r => r.query).sort()
    assert.deepEqual(queries, ['to:me', 'to:my_labels'],
      'reanimate restores both mandatory slots; a reanimated agent keeps the same pair a mint writes')

    // markAlive on a living agent is a no-op, not a reconcile: an agent that
    // deliberately dropped its direct slot keeps that choice.
    store.upsertAgent({ id: 'fleet:quiet', friendly_name: 'quiet' })
    assert.deepEqual(store.getSubscriptionsByOwner('fleet:quiet').map(r => r.query), [],
      'a living agent starts with no slots — control that the reseed below comes from markAlive, not mint')
    assert.equal(store.markAlive('fleet:quiet').id, 'fleet:quiet')
    assert.deepEqual(store.getSubscriptionsByOwner('fleet:quiet').map(r => r.query), [],
      'markAlive on a living agent adds nothing')
  } finally {
    cleanup()
  }
})

// The observed incident, at store level: kill ends every subscription, then a
// revival that clears `dead` WITHOUT markAlive (the register/login upsert
// path) leaves the agent reading not-dead with zero live rows — the exact
// state skip-math-team-sol was found in, where `reanimate` then refused
// `not dead`. upsertAgent must reseed the same mandatory pair markAlive does.
test('a dead-to-live upsert revival reseeds both mandatory slots', () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsertAgent({ id: 'fleet:revived', friendly_name: 'revived' })
    store.ensureSubscription({
      owner: 'fleet:revived', query: 'to:me',
      notificationPolicy: 'immediate', mandatory: true,
    })
    store.ensureSubscription({
      owner: 'fleet:revived', query: 'to:my_labels',
      notificationPolicy: 'immediate', mandatory: true,
    })
    store.markDead('fleet:revived')
    assert.equal(store.getSubscriptionsByOwner('fleet:revived').length, 0,
      'control: death ends both slots')

    // Counterfactual: without the upsert-path reseed this is the incident —
    // dead clears, subscriptions stay ended, `reanimate` refuses `not dead`.
    const dead = store.getAgent('fleet:revived')
    assert.equal(dead.dead, true, 'control: the agent is dead before revival')
    store.upsertAgent({ ...dead, dead: false, last_seen: new Date().toISOString() })

    const revived = store.getAgent('fleet:revived')
    assert.equal(revived.dead, false, 'the revival clears the dead flag')
    assert.deepEqual(
      store.getSubscriptionsByOwner('fleet:revived').map(r => r.query).sort(),
      ['to:me', 'to:my_labels'],
      'the revival reseeds both mandatory slots, exactly once each',
    )
    assert.ok(
      store.resolveSubscriptionDeliveries('fleet:sender', 'fleet:revived', 'chat')
        .some(m => m.direct && m.query === 'to:me'),
      'addressed chat resolves a direct delivery after an upsert revival',
    )

    // A live re-register is not a revival: nothing is added, nothing duplicated.
    const before = store.getSubscriptionsByOwner('fleet:revived').length
    store.upsertAgent({ ...store.getAgent('fleet:revived'), last_seen: new Date().toISOString() })
    assert.equal(store.getSubscriptionsByOwner('fleet:revived').length, before,
      're-registering a living agent adds no rows')
  } finally {
    cleanup()
  }
})

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForServer(child) {
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function openFleetWs(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}

function request(ws, id, type, payload) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      const message = JSON.parse(String(raw))
      if (message.id !== id) return
      ws.off('message', onMessage)
      if (message.error) reject(new Error(message.error))
      else resolve(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, type, ...payload }))
  })
}

// The subscription-less half, through the actual send path. The store-level
// match (`resolveSubscriptionDeliveries` returns no direct match) is the setup,
// not the assertion: without the `reserveSubscriptionBatch` null guard this
// same send threw `Cannot read properties of null (reading 'delivery')`
// instead of recording the bounded `no_direct_subscription` outcome the
// handler's own entry branch already names. Measured 2026-09-21 on a
// reanimated PM whose subscriptions death had ended.
test('a chat to a subscription-less recipient records no_direct_subscription instead of throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-reanimate-nosub-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  const now = new Date().toISOString()
  await store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender', labels: [], registered_at: now, last_seen: now })
  await store.upsertAgent({ id: 'fleet:silent', friendly_name: 'silent', labels: [], registered_at: now, last_seen: now })
  // A route and no socket: what hibernating looks like to the server. Without
  // the route the `deliveryBlockReason` branch wins (`accepted: recipient has
  // no daemon route`) and the test would assert the wrong outcome while still
  // passing the doesn't-throw half.
  store.setAgentDaemonRoute('fleet:silent', 'mini:testing')
  assert.deepEqual(store.getSubscriptionsByOwner('fleet:silent'), [],
    'control: the recipient genuinely holds no subscription')
  assert.deepEqual(
    store.resolveSubscriptionDeliveries('fleet:sender', 'fleet:silent', 'chat').filter(m => m.direct),
    [],
    'control: no direct match, so deliveryDecision is null and the guard is what runs',
  )
  await store.close()

  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), PROJECTS_DIR: join(dir, 'projects'),
      TLDA_FLEET_DB: dbPath, TLDA_DEV_SERVER: '1', TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let senderWs
  try {
    await waitForServer(child)
    senderWs = await openFleetWs(port)
    // Without the null guard this rejects with
    // `Cannot read properties of null (reading 'delivery')` — a thrown error,
    // not a recorded outcome. With it the send succeeds and the receipt names
    // the bounded failure the entry branch already carries.
    const sent = await request(senderWs, 2, 'chat', {
      from: 'fleet:sender', to: 'silent', message: 'a note nobody subscribed to',
      _tempId: 'reanimate-nosub-proof',
    })
    assert.equal(sent.ok, true, 'the send must complete, not throw')
    const [receipt] = sent.receipts
    assert.equal(receipt?.delivery, 'no_direct_subscription',
      `the receipt must record the bounded outcome. Saw: ${JSON.stringify(sent.receipts)}`)
    assert.equal(receipt?.reason, 'no matching direct subscription')
  } finally {
    senderWs?.close()
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    removeTempDir(dir)
  }
})
