import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'

test('agent route projection carries the daemon address used by RPC routing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-daemon-route-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    store.upsertAgent({ id: 'fleet:chief', friendly_name: 'chief', labels: [] })
    store.setAgentDaemonRoute('fleet:chief', 'mini:testing')

    assert.deepEqual(
      {
        daemon_key: store.getAgent('fleet:chief').daemon_key,
        machine_id: store.getAgent('fleet:chief').machine_id,
        env_name: store.getAgent('fleet:chief').env_name,
      },
      { daemon_key: 'mini:testing', machine_id: 'mini', env_name: 'testing' },
    )
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
