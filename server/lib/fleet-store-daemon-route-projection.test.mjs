import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'

// This used to assert that the projection ALSO split the key into `machine_id`
// and `env_name`. It no longer does: four of the readers of those two fields
// immediately rejoined them with `daemonAddress()`, and the columns they were
// named after were dropped from `agents` on 2026-07-28 (4cdbb55b8). The
// property that matters is unchanged and is what this asserts — the projection
// carries the daemon key that RPC routing keys `daemonConnections` on.
test('agent route projection carries the daemon key RPC routing uses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-daemon-route-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    store.upsertAgent({ id: 'fleet:chief', friendly_name: 'chief', labels: [] })
    store.setAgentDaemonRoute('fleet:chief', 'mini:testing')

    const routed = store.getAgent('fleet:chief')
    assert.equal(routed.route_daemon_key, 'mini:testing')
    assert.equal(routed.route_present, true)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// The other half of the same contract, and the one resolveRpc's 503 depends on:
// an agent with no route row carries no key, so nothing can route to it.
test('an agent with no route carries no daemon key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-daemon-route-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    store.upsertAgent({ id: 'fleet:routeless', friendly_name: 'routeless', labels: [] })

    const agent = store.getAgent('fleet:routeless')
    assert.equal(agent.route_daemon_key, null)
    assert.equal(agent.route_present, false)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
