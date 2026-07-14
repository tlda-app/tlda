import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { FleetStore } from '../server/lib/fleet-store.mjs'

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-agent-seat-'))
  const store = new FleetStore(path.join(dir, 'fleet.db'), { taskDoc: false })
  return { dir, store }
}

function closeStore({ dir, store }) {
  store.close?.()
  fs.rmSync(dir, { recursive: true, force: true })
}

function seat(overrides = {}) {
  return {
    agent_id: 'fleet:66660cc3',
    session_id: '019f6034-0000-4000-8000-000000000000',
    resume_id: '019f6034-0000-4000-8000-000000000000',
    kind: 'codex',
    model: 'gpt-5.6-sol',
    cwd: '/Users/skip/work/tlda',
    machine_id: 'mini',
    env_name: 'fly',
    daemon_key: 'mini:fly',
    tmux_session: 'fleet-icantevengetafuckinglist',
    created_source: 'test',
    created_by_event_id: 1206006,
    ...overrides,
  }
}

test('agent identity insert is validate-equal and cannot replace session or model', () => {
  const ctx = tmpStore()
  try {
    const first = ctx.store.insertAgentSeat(seat())
    assert.equal(first.agent_id, 'fleet:66660cc3')
    const same = ctx.store.insertAgentSeat(seat())
    assert.equal(same.session_id, first.session_id)

    assert.throws(
      () => ctx.store.insertAgentSeat(seat({ session_id: 'different-session' })),
      /seat identity conflict.*session_id/,
    )
    assert.throws(
      () => ctx.store.insertAgentSeat(seat({ model: 'different-model' })),
      /seat identity conflict.*model/,
    )
  } finally {
    closeStore(ctx)
  }
})

test('runtime binding updates the route for the same identity and enforces endpoint uniqueness', () => {
  const ctx = tmpStore()
  try {
    ctx.store.insertAgentSeat(seat())
    const current = ctx.store.activateAgentSeat({
      agentId: 'fleet:66660cc3',
      sessionId: '019f6034-0000-4000-8000-000000000000',
      machineId: 'mini',
      envName: 'fly',
      daemonKey: 'mini:fly',
      tmuxSession: 'fleet-icantevengetafuckinglist',
      reason: 'fresh-create',
    })
    assert.equal(current.session_id, '019f6034-0000-4000-8000-000000000000')
    assert.equal(current.tmux_session, 'fleet-icantevengetafuckinglist')

    ctx.store.insertAgentSeat(seat({
      agent_id: 'fleet:9c06d1ba',
      session_id: '019f9999-0000-4000-8000-000000000000',
      resume_id: '019f9999-0000-4000-8000-000000000000',
      tmux_session: 'fleet-liveness',
    }))
    ctx.store.activateAgentSeat({
      agentId: 'fleet:9c06d1ba',
      sessionId: '019f9999-0000-4000-8000-000000000000',
      machineId: 'mini',
      envName: 'fly',
      daemonKey: 'mini:fly',
      tmuxSession: 'fleet-liveness',
      reason: 'fresh-create',
    })

    ctx.store.insertAgentSeat(seat({
      agent_id: 'fleet:other',
      session_id: '019faaaa-0000-4000-8000-000000000000',
      resume_id: '019faaaa-0000-4000-8000-000000000000',
      tmux_session: 'fleet-icantevengetafuckinglist',
    }))
    assert.throws(
      () => ctx.store.activateAgentSeat({
        agentId: 'fleet:other',
        sessionId: '019faaaa-0000-4000-8000-000000000000',
        machineId: 'mini',
        envName: 'fly',
        daemonKey: 'mini:fly',
        tmuxSession: 'fleet-icantevengetafuckinglist',
        reason: 'fresh-create',
      }),
      /current tmux endpoint.*already belongs to fleet:66660cc3/,
    )
  } finally {
    closeStore(ctx)
  }
})

test('runtime binding cannot replace an agent identity session', () => {
  const ctx = tmpStore()
  try {
    ctx.store.insertAgentSeat(seat())
    ctx.store.activateAgentSeat({
      agentId: 'fleet:66660cc3',
      sessionId: '019f6034-0000-4000-8000-000000000000',
      machineId: 'mini',
      envName: 'fly',
      daemonKey: 'mini:fly',
      tmuxSession: 'fleet-icantevengetafuckinglist',
      reason: 'fresh-create',
    })
    assert.throws(
      () => ctx.store.activateAgentSeat({
        agentId: 'fleet:66660cc3',
        sessionId: '019fbbbb-0000-4000-8000-000000000000',
        machineId: 'mini',
        envName: 'fly',
        daemonKey: 'mini:fly',
        tmuxSession: 'fleet-icantevengetafuckinglist-v2',
        reason: 'wake',
      }),
      /seat identity conflict.*session_id/,
    )
    const updated = ctx.store.activateAgentSeat({
      agentId: 'fleet:66660cc3',
      sessionId: '019f6034-0000-4000-8000-000000000000',
      machineId: 'mini',
      envName: 'fly',
      daemonKey: 'mini:fly',
      tmuxSession: 'fleet-icantevengetafuckinglist-v2',
      reason: 'wake',
    })
    assert.equal(updated.session_id, '019f6034-0000-4000-8000-000000000000')
    assert.equal(updated.tmux_session, 'fleet-icantevengetafuckinglist-v2')
  } finally {
    closeStore(ctx)
  }
})

test('seat validation catches exact id-X tmux-Y corruption', () => {
  const ctx = tmpStore()
  try {
    ctx.store.insertAgentSeat(seat())
    ctx.store.activateAgentSeat({
      agentId: 'fleet:66660cc3',
      sessionId: '019f6034-0000-4000-8000-000000000000',
      machineId: 'mini',
      envName: 'fly',
      daemonKey: 'mini:fly',
      tmuxSession: 'fleet-icantevengetafuckinglist',
      reason: 'fresh-create',
    })

    assert.throws(
      () => ctx.store.validateCurrentAgentSeat('fleet:66660cc3', {
        session_id: '019f6034-0000-4000-8000-000000000000',
        tmux_session: 'fleet-liveness',
      }),
      /seat identity conflict.*tmux_session/,
    )

    const ok = ctx.store.validateCurrentAgentSeat('fleet:66660cc3', {
      session_id: '019f6034-0000-4000-8000-000000000000',
      tmux_session: 'fleet-icantevengetafuckinglist',
    })
    assert.equal(ok.agent_id, 'fleet:66660cc3')
  } finally {
    closeStore(ctx)
  }
})
