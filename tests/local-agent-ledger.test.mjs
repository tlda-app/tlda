import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'

import { createLocalAgentLedger } from '../agent-launch/local-agent-ledger.mjs'

function withLedger(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-local-agent-ledger-'))
    const ledger = createLocalAgentLedger(path.join(dir, 'fleet-daemon.db'))
    try { await fn(ledger) } finally {
      ledger.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('local agent exists without server identity and owns canonical local records', withLedger((ledger) => {
  const agent = ledger.create({
    localAgentId: 'local:test',
    friendlyName: null,
    sessionId: 'session-1',
    harness: 'codex',
    model: 'gpt-5.5',
    tmuxName: 'fleet-test',
    cwd: '/tmp/project',
    permissionProfile: 'wd',
  })
  assert.equal(agent.localAgentId, 'local:test')
  assert.equal(agent.serverAgentId, null)
  assert.equal(agent.conversation.sessionId, 'session-1')
  assert.equal(agent.process.tmuxName, 'fleet-test')
}))

test('server identity binding is one-time, immutable, unique, and idempotent', withLedger((ledger) => {
  ledger.create({ localAgentId: 'local:one' })
  ledger.create({ localAgentId: 'local:two' })
  assert.equal(ledger.bind('local:one', 'fleet:server').serverAgentId, 'fleet:server')
  assert.equal(ledger.bind('local:one', 'fleet:server').serverAgentId, 'fleet:server')
  assert.throws(() => ledger.bind('local:one', 'fleet:other'), /already bound/)
  assert.throws(() => ledger.bind('local:two', 'fleet:server'), /already bound/)
  assert.equal(ledger.get('fleet:server').localAgentId, 'local:one')
}))

test('conversation and process remain keyed by local identity after binding', withLedger((ledger) => {
  ledger.create({ localAgentId: 'local:stable', sessionId: 's1', tmuxName: 't1' })
  ledger.bind('local:stable', 'fleet:bound')
  ledger.updateConversation('fleet:bound', { model: 'gpt-5.5' })
  ledger.updateProcess('fleet:bound', { tmuxName: 't2' })
  const agent = ledger.get('local:stable')
  assert.equal(agent.conversation.sessionId, 's1')
  assert.equal(agent.conversation.model, 'gpt-5.5')
  assert.equal(agent.process.tmuxName, 't2')
}))

test('legacy daemon rows do not mint local wake recipes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-local-agent-migration-'))
  const file = path.join(dir, 'fleet-daemon.db')
  const db = new Database(file)
  db.exec(`
    CREATE TABLE permission_grants (
      id TEXT PRIMARY KEY, spawn_policy TEXT, friendly_name TEXT, session_id TEXT,
      session_kind TEXT, tmux_session TEXT, model TEXT, cwd TEXT
    )
  `)
  db.prepare('INSERT INTO permission_grants VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('fleet:legacy', '{"name":"wd"}', 'legacy', 'session-old', 'codex', 'fleet-legacy', 'gpt-5.5', '/tmp/legacy')
  db.prepare('INSERT INTO permission_grants VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('ambiguous', '{"name":"wd"}', null, null, null, null, null, null)
  db.prepare('INSERT INTO permission_grants VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('fleet:corrupt', '{not-json', null, null, null, null, null, null)
  db.close()
  const ledger = createLocalAgentLedger(file)
  try {
    assert.equal(ledger.get('fleet:legacy'), null)
    assert.equal(ledger.findByFriendlyName('legacy'), null)
    assert.equal(ledger.get('fleet:corrupt'), null)
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM local_agent_migration_issues').get().n, 0)
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM local_agents').get().n, 0)
  } finally {
    ledger.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('current durable recipe rows still resolve by server id and friendly name', withLedger((ledger) => {
  ledger.create({
    localAgentId: 'local:current',
    serverAgentId: 'fleet:current',
    friendlyName: 'current-agent',
    sessionId: 'session-current',
    harness: 'codex',
    model: 'gpt-5.5',
    tmuxName: 'fleet-current-agent',
    cwd: '/tmp/current',
    permissionProfile: 'app-dev',
  })

  const byServer = ledger.get('fleet:current')
  assert.equal(byServer.localAgentId, 'local:current')
  assert.equal(byServer.process.permissionProfile, 'app-dev')
  assert.equal(byServer.process.tmuxName, 'fleet-current-agent')
  assert.equal(byServer.conversation.harness, 'codex')

  const byName = ledger.findByFriendlyName('current-agent')
  assert.equal(byName.serverAgentId, 'fleet:current')
  assert.equal(byName.process.permissionProfile, 'app-dev')
}))
