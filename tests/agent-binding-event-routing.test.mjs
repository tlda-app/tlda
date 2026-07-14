import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { recordAgentBindingEvent } from '../server/lib/agent-binding-events.mjs'
import { FleetStore } from '../server/lib/fleet-store.mjs'

function tempStore() {
  const dbPath = path.join(os.tmpdir(), `tlda-agent-binding-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  return { store: new FleetStore(dbPath, { taskDoc: false }), dbPath }
}

function cleanup(store, dbPath) {
  store.close()
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(file) } catch (e) {
      if (e?.code !== 'ENOENT') throw e
    }
  }
}

function bindingEvent(patch = {}) {
  return {
    type: 'agent-seat',
    agent_id: 'fleet:chief',
    session_id: 'session-one',
    resume_id: 'session-one',
    kind: 'codex',
    model: 'gpt-5.5',
    cwd: '/Users/skip/work/tlda',
    machine_id: 'mini',
    env_name: 'fly',
    daemon_key: 'mini:fly',
    tmux_session: 'fleet-chief',
    created_source: 'spawn-runtime',
    ...patch,
  }
}

test('production event creates immutable identity and current runtime binding', () => {
  const { store, dbPath } = tempStore()
  try {
    recordAgentBindingEvent(store, bindingEvent())
    const current = store.getCurrentAgentSeat('fleet:chief')
    assert.equal(current.session_id, 'session-one')
    assert.equal(current.tmux_session, 'fleet-chief')
  } finally {
    cleanup(store, dbPath)
  }
})

test('wake may replace only the runtime route for the same identity', () => {
  const { store, dbPath } = tempStore()
  try {
    recordAgentBindingEvent(store, bindingEvent())
    recordAgentBindingEvent(store, bindingEvent({
      machine_id: 'air',
      daemon_key: 'air:fly',
      tmux_session: 'fleet-chief-woken',
    }))
    const current = store.getCurrentAgentSeat('fleet:chief')
    assert.equal(current.session_id, 'session-one')
    assert.equal(current.machine_id, 'air')
    assert.equal(current.tmux_session, 'fleet-chief-woken')
  } finally {
    cleanup(store, dbPath)
  }
})

test('production event cannot replace session or claim another agent endpoint', () => {
  const { store, dbPath } = tempStore()
  try {
    recordAgentBindingEvent(store, bindingEvent())
    assert.throws(() => recordAgentBindingEvent(store, bindingEvent({
      session_id: 'session-two',
      resume_id: 'session-two',
    })), /seat identity conflict.*session_id/)
    recordAgentBindingEvent(store, bindingEvent({
      agent_id: 'fleet:liveness',
      session_id: 'session-liveness',
      resume_id: 'session-liveness',
      tmux_session: 'fleet-liveness',
    }))
    assert.throws(() => recordAgentBindingEvent(store, bindingEvent({
      tmux_session: 'fleet-liveness',
    })), /current tmux endpoint.*already belongs to fleet:liveness/)
  } finally {
    cleanup(store, dbPath)
  }
})
