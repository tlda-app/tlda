import assert from 'node:assert/strict'

import { SpawnLibrarian } from '../shared/spawn-librarian.ts'
import { observeSpawnAcceptedSeat, observeSpawnProcessLogin, readAcceptedCurrentSeat } from '../server/lib/spawn-seat-acceptance.mjs'

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve))
}

function fixture(suffix) {
  const librarian = new SpawnLibrarian({ loginDeadlineMs: 5_000 })
  const agent = { id: `fleet:${suffix}`, friendly_name: suffix }
  const seat = {
    agent_id: agent.id,
    session_id: `session:${suffix}`,
    daemon_key: `machine:${suffix}:prod`,
    terminal_capability: `terminal:${suffix}`,
    activated_at: '2026-07-22T12:00:00.000Z',
  }
  return { librarian, agent, seat }
}

function awaitAccepted(librarian, agent, store) {
  return librarian.awaitAcceptedSeat({
    id: agent.id,
    name: agent.friendly_name,
    isSeatCurrent: candidate => !!readAcceptedCurrentSeat(store, agent.id, candidate),
  })
}

{
  const { librarian, agent, seat } = fixture('login-first')
  const store = { getCurrentAgentSeat: () => seat }
  let outcome = null
  const readiness = awaitAccepted(librarian, agent, store)
  readiness.then(result => { outcome = result })
  observeSpawnProcessLogin(librarian, agent)
  await nextTurn()
  assert.equal(outcome, null, 'generic login resolved spawn before durable seat acceptance')
  observeSpawnAcceptedSeat(librarian, store, agent.id, seat)
  assert.deepEqual(await readiness, { ok: true, agent })
}

{
  const { librarian, agent, seat } = fixture('seat-first')
  const store = { getCurrentAgentSeat: () => seat }
  let outcome = null
  const readiness = awaitAccepted(librarian, agent, store)
  readiness.then(result => { outcome = result })
  observeSpawnAcceptedSeat(librarian, store, agent.id, seat)
  await nextTurn()
  assert.equal(outcome, null, 'seat acceptance resolved spawn before process login')
  observeSpawnProcessLogin(librarian, agent)
  assert.deepEqual(await readiness, { ok: true, agent })
}

{
  const { librarian, agent, seat } = fixture('invalid-seat')
  const store = { getCurrentAgentSeat: () => seat }
  let resolutions = 0
  const readiness = awaitAccepted(librarian, agent, store)
  readiness.then(() => { resolutions += 1 })
  observeSpawnProcessLogin(librarian, agent)
  observeSpawnAcceptedSeat(librarian, store, agent.id, { ...seat, agent_id: 'fleet:wrong-agent' })
  observeSpawnAcceptedSeat(librarian, store, agent.id, { ...seat, terminal_capability: null })
  await nextTurn()
  assert.equal(resolutions, 0)
  observeSpawnAcceptedSeat(librarian, store, agent.id, seat)
  observeSpawnAcceptedSeat(librarian, store, agent.id, seat)
  assert.deepEqual(await readiness, { ok: true, agent })
  await nextTurn()
  assert.equal(resolutions, 1, 'duplicate observations resolved readiness more than once')
}

{
  const current = {
    agent_id: 'fleet:readback',
    session_id: 'session:current',
    daemon_key: 'machine:readback:prod',
    terminal_capability: 'terminal:current',
    activated_at: '2026-07-22T12:00:00.000Z',
  }
  const store = { getCurrentAgentSeat: () => current }
  assert.equal(readAcceptedCurrentSeat({ getCurrentAgentSeat: () => null }, current.agent_id, null), null)
  assert.equal(readAcceptedCurrentSeat(store, current.agent_id, { ...current, session_id: 'session:stale' }), null)
  assert.equal(readAcceptedCurrentSeat(store, current.agent_id, { ...current, agent_id: 'fleet:wrong-agent' }), null)
  assert.equal(readAcceptedCurrentSeat(store, current.agent_id, { ...current, terminal_capability: null }), null)
  assert.deepEqual(readAcceptedCurrentSeat(store, current.agent_id, current), current)
}

{
  const { librarian, agent, seat } = fixture('revoked-before-login')
  let current = seat
  const store = { getCurrentAgentSeat: () => current }
  let outcome = null
  const readiness = awaitAccepted(librarian, agent, store)
  readiness.then(result => { outcome = result })

  observeSpawnAcceptedSeat(librarian, store, agent.id, seat)
  current = { ...seat, terminal_capability: null, activated_at: '2026-07-22T12:00:01.000Z' }
  observeSpawnProcessLogin(librarian, agent)
  observeSpawnAcceptedSeat(librarian, store, agent.id, current)
  await nextTurn()
  assert.equal(outcome, null, 'login resolved from a terminal capability revoked after seat observation')

  current = { ...seat, terminal_capability: 'terminal:restored', activated_at: '2026-07-22T12:00:02.000Z' }
  observeSpawnAcceptedSeat(librarian, store, agent.id, current)
  assert.deepEqual(await readiness, { ok: true, agent })
}

{
  const { librarian, agent, seat } = fixture('replaced-before-login')
  let current = seat
  const store = { getCurrentAgentSeat: () => current }
  let outcome = null
  const readiness = awaitAccepted(librarian, agent, store)
  readiness.then(result => { outcome = result })

  observeSpawnAcceptedSeat(librarian, store, agent.id, seat)
  current = {
    ...seat,
    session_id: 'session:replacement',
    terminal_capability: 'terminal:replacement',
    activated_at: '2026-07-22T12:00:01.000Z',
  }
  observeSpawnProcessLogin(librarian, agent)
  observeSpawnAcceptedSeat(librarian, store, agent.id, seat)
  await nextTurn()
  assert.equal(outcome, null, 'login resolved from a replaced current seat')

  observeSpawnAcceptedSeat(librarian, store, agent.id, current)
  assert.deepEqual(await readiness, { ok: true, agent })
}

{
  const { librarian, agent, seat } = fixture('route-change')
  let current = seat
  const store = { getCurrentAgentSeat: () => current }
  let outcome = null
  const readiness = awaitAccepted(librarian, agent, store)
  readiness.then(result => { outcome = result })
  observeSpawnAcceptedSeat(librarian, store, agent.id, seat)
  current = { ...seat, daemon_key: 'machine:other:prod', activated_at: '2026-07-22T12:00:01.000Z' }
  observeSpawnProcessLogin(librarian, agent)
  await nextTurn()
  assert.equal(outcome, null, 'daemon-route change resolved a stale seat observation')
  observeSpawnAcceptedSeat(librarian, store, agent.id, current)
  assert.deepEqual(await readiness, { ok: true, agent })
}

{
  const { librarian, agent, seat } = fixture('never-observed')
  const store = { getCurrentAgentSeat: () => seat }
  let outcome = null
  const readiness = awaitAccepted(librarian, agent, store)
  readiness.then(result => { outcome = result })
  observeSpawnProcessLogin(librarian, agent)
  await nextTurn()
  assert.equal(outcome, null, 'a current seat never observed by this waiter resolved at login')
  observeSpawnAcceptedSeat(librarian, store, agent.id, seat)
  assert.deepEqual(await readiness, { ok: true, agent })
}

{
  const { librarian, agent, seat } = fixture('null-readback')
  let current = seat
  const store = { getCurrentAgentSeat: () => current }
  let outcome = null
  const readiness = awaitAccepted(librarian, agent, store)
  readiness.then(result => { outcome = result })
  observeSpawnAcceptedSeat(librarian, store, agent.id, seat)
  current = null
  observeSpawnProcessLogin(librarian, agent)
  await nextTurn()
  assert.equal(outcome, null, 'null current-seat readback resolved a stored observation')
  current = { ...seat, activated_at: '2026-07-22T12:00:01.000Z' }
  observeSpawnAcceptedSeat(librarian, store, agent.id, current)
  assert.deepEqual(await readiness, { ok: true, agent })
}

{
  const { librarian, agent } = fixture('login-only-api')
  const readiness = librarian.awaitLogin({ id: agent.id, name: agent.friendly_name })
  observeSpawnProcessLogin(librarian, agent)
  assert.deepEqual(await readiness, { ok: true, agent })
}

{
  const librarian = new SpawnLibrarian({ loginDeadlineMs: 5 })
  const agent = { id: 'fleet:acceptance-timeout', friendly_name: 'acceptance-timeout' }
  const store = { getCurrentAgentSeat: () => null }
  const readiness = awaitAccepted(librarian, agent, store)
  observeSpawnProcessLogin(librarian, agent)
  assert.deepEqual(await readiness, { ok: false, reason: 'acceptance-timeout' })
}

console.log('spawn seat acceptance regression: ok')
