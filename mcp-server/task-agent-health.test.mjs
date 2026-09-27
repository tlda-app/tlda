// Acceptance for the heartbeat-as-production fix: a heads-down worker whose
// heartbeats advance on observed activity is healthy past the 10-minute
// threshold — the same agent shape without activity heartbeats is exactly the
// stale-heartbeat false positive from the notify-defects row.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.FLEET_ID = 'fleet:test-agent'
const CONFIG_DIR_FIXTURE = mkdtempSync(join(tmpdir(), 'task-agent-health-'))
process.env.TLDA_CONFIG_DIR = CONFIG_DIR_FIXTURE
process.env.TLDA_ENV = 'task-agent-health-test'
writeFileSync(join(CONFIG_DIR_FIXTURE, 'daemon.yaml'), [
  'environments:',
  '  default: task-agent-health-test',
  '  values:',
  '    task-agent-health-test:',
  '      database: http://127.0.0.1:1',
  '      store: http://127.0.0.1:1',
  '      licenseKey: ""',
  '',
].join('\n'))

const { classifyTaskAgentHealth } = await import('./fleet-tools.mjs')

const NOW = Date.parse('2026-09-27T14:30:00.000Z')
const isoAgo = minutes => new Date(NOW - minutes * 60 * 1000).toISOString()

function task(overrides = {}) {
  return {
    id: 'fleet:2b81-mujxvt14',
    agent: 'fleet:worker',
    status: 'active',
    delegated_at: isoAgo(13),
    metadata: {},
    ...overrides,
  }
}

function agent(overrides = {}) {
  return {
    id: 'fleet:worker',
    friendly_name: 'worker',
    runtime_status: { kind: 'ai', status: 'awake' },
    dead: false,
    last_seen: isoAgo(2),
    ...overrides,
  }
}

test('heads-down worker with activity heartbeats is healthy past the threshold', async () => {
  // No chats, no inbox acks for 13 minutes — but the daemon sent heartbeats on
  // observed tool activity, so last_seen is 2 minutes old.
  const health = classifyTaskAgentHealth(task(), agent(), { nowMs: NOW })

  assert.equal(health.level, 'ok')
  assert.equal(health.code, 'healthy')
})

test('same agent without activity heartbeats is the stale false positive', async () => {
  // Before-picture on the same agent shape: last_seen 13 minutes old because
  // nothing but chats/logins/acks refreshed it.
  const health = classifyTaskAgentHealth(task(), agent({ last_seen: isoAgo(13) }), { nowMs: NOW })

  assert.equal(health.level, 'warning')
  assert.equal(health.code, 'stale-heartbeat')
  assert.match(health.text, /no heartbeat from worker for 13m/)
})

test('pending-pickup stops blaming the agent for undelivered notices', async () => {
  const health = classifyTaskAgentHealth(
    task({ status: 'pending' }),
    agent(),
    { nowMs: NOW },
  )

  assert.equal(health.code, 'pending-pickup')
  assert.match(health.managerAction, /never have been notified/)
  assert.equal(health.managerAction.includes('may not have called inbox'), false)
})
