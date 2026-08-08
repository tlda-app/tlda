import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'

test('marking an agent dead preserves the daemon route needed to reanimate it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-fleet-reanimate-route-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    const now = new Date().toISOString()
    store.db.prepare(`
      INSERT INTO agents (id, friendly_name, labels, registered_at, last_seen, last_active, dead, human, metadata)
      VALUES (?, ?, '[]', ?, ?, ?, 0, 0, '{}')
    `).run('fleet:agent', 'agent', now, now, now)
    store.setAgentDaemonRoute('fleet:agent', 'mini:testing')

    store.markDead('fleet:agent')

    assert.deepEqual(store.getAgentDaemonRoute('fleet:agent'), {
      agent_id: 'fleet:agent',
      daemon_key: 'mini:testing',
    })
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
