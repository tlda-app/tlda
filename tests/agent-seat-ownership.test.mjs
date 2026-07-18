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

function reopenStore(ctx) {
  ctx.store.close?.()
  ctx.store = new FleetStore(path.join(ctx.dir, 'fleet.db'), { taskDoc: false })
  return ctx.store
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

test('daemon roster projects current durable seat fields over legacy agent route fields', () => {
  const ctx = tmpStore()
  try {
    ctx.store.upsertAgent({
      id: 'fleet:66660cc3',
      friendly_name: 'seat-projection-test',
      tmux_session: 'legacy-tmux',
      session_id: 'legacy-session',
      session_ids: ['legacy-session'],
      cwd: '/legacy/cwd',
      machine_id: 'legacy-machine',
      env_name: 'legacy-env',
      daemon_key: 'legacy-machine:legacy-env',
      resume_id: 'legacy-resume',
      dead: false,
      human: false,
    }, { allowProtectedAgentFields: true })
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

    const [agent] = ctx.store.getAgentsByDaemonKey('mini:fly')
    assert.equal(agent.tmux_session, 'fleet-icantevengetafuckinglist')
    assert.equal(agent.session_id, '019f6034-0000-4000-8000-000000000000')
    assert.equal(agent.cwd, '/Users/skip/work/tlda')
    assert.equal(agent.machine_id, 'mini')
    assert.equal(agent.env_name, 'fly')
    assert.equal(agent.daemon_key, 'mini:fly')
    assert.equal(agent.resume_id, '019f6034-0000-4000-8000-000000000000')

    const projected = ctx.store.projectAgentCurrentSeat(ctx.store.getAgent('fleet:66660cc3'))
    assert.equal(projected.tmux_session, agent.tmux_session)
    assert.equal(projected.session_id, agent.session_id)
    assert.equal(projected.cwd, agent.cwd)
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

test('startup backfills current seat for complete legacy live agent route rows', () => {
  const ctx = tmpStore()
  try {
    ctx.store.upsertAgent({
      id: 'fleet:2d20ff53',
      friendly_name: 'recovery-chief-sol',
      tmux_session: 'fleet-recovery-chief-sol',
      session_id: '019f6273-aaf1-7733-870b-516820696860',
      session_ids: ['019f6273-aaf1-7733-870b-516820696860'],
      cwd: '/Users/skip/work/tlda',
      machine_id: 'mini',
      env_name: 'default',
      daemon_key: 'mini:default',
      resume_id: '019f6273-aaf1-7733-870b-516820696860',
      metadata: { kind: 'codex', model: 'gpt-5.5' },
      dead: false,
      human: false,
    }, { allowProtectedAgentFields: true })
    assert.equal(ctx.store.getCurrentAgentSeat('fleet:2d20ff53'), null)

    reopenStore(ctx)
    const current = ctx.store.getCurrentAgentSeat('fleet:2d20ff53')
    assert.equal(current.session_id, '019f6273-aaf1-7733-870b-516820696860')
    assert.equal(current.tmux_session, 'fleet-recovery-chief-sol')
    assert.equal(current.machine_id, 'mini')
    assert.equal(current.env_name, 'default')
    assert.equal(current.daemon_key, 'mini:default')
    assert.equal(current.kind, 'codex')
    assert.equal(current.model, 'gpt-5.5')
    assert.equal(current.transition_reason, 'legacy-agent-route-backfill')
  } finally {
    closeStore(ctx)
  }
})

test('daemon roster ignores a legacy route without a current durable seat', () => {
  const ctx = tmpStore()
  try {
    ctx.store.upsertAgent({
      id: 'fleet:legacy-bot',
      friendly_name: 'legacy-bot',
      tmux_session: 'fleet-bot-legacy',
      cwd: '/Users/skip/work/tlda',
      machine_id: 'mini',
      env_name: 'default',
      daemon_key: 'mini:default',
      metadata: { bot: 'legacy-bot' },
      dead: false,
      human: false,
    }, { allowProtectedAgentFields: true })

    assert.equal(ctx.store.getCurrentAgentSeat('fleet:legacy-bot'), null)
    assert.deepEqual(ctx.store.getAgentsByDaemonKey('mini:default'), [])
  } finally {
    closeStore(ctx)
  }
})

test('generic agent upsert cannot create or mutate protected identity and route fields', () => {
  const ctx = tmpStore()
  try {
    assert.throws(
      () => ctx.store.upsertAgent({
        id: 'fleet:new-generic',
        friendly_name: 'new-generic',
        session_id: 'generic-session',
      }),
      /generic upsertAgent cannot write protected.*session_id/,
    )

    ctx.store.upsertAgent({
      id: 'fleet:protected',
      friendly_name: 'protected',
      tmux_session: 'tmux-original',
      session_id: 'session-original',
      session_ids: ['session-original'],
      cwd: '/Users/skip/work/tlda',
      machine_id: 'mini',
      env_name: 'fly',
      daemon_key: 'mini:fly',
      resume_id: 'resume-original',
    }, { allowProtectedAgentFields: true })

    const unchanged = ctx.store.getAgent('fleet:protected')
    unchanged.labels = ['reviewed']
    ctx.store.upsertAgent(unchanged)
    assert.deepEqual(ctx.store.getAgent('fleet:protected').labels, ['reviewed'])

    for (const [field, value] of [
      ['tmux_session', 'tmux-hijack'],
      ['session_id', 'session-hijack'],
      ['session_ids', ['session-original', 'session-hijack']],
      ['session_ids', []],
      ['cwd', '/tmp/hijack'],
      ['machine_id', 'air'],
      ['env_name', 'local'],
      ['daemon_key', 'air:local'],
      ['resume_id', 'resume-hijack'],
    ]) {
      assert.throws(
        () => ctx.store.upsertAgent({ ...ctx.store.getAgent('fleet:protected'), [field]: value }),
        new RegExp(`generic upsertAgent cannot write protected.*${field}`),
        `${field} must not be generic-upsert mutable`,
      )
    }
  } finally {
    closeStore(ctx)
  }
})
