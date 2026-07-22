import assert from 'node:assert/strict'

import { SpawnLibrarian } from '../shared/spawn-librarian.ts'
import { readAcceptedCurrentSeat } from '../server/lib/spawn-seat-acceptance.mjs'

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve))
}

function fixture(suffix) {
  const librarian = new SpawnLibrarian({ loginDeadlineMs: 5_000 })
  const agent = { id: `fleet:${suffix}`, friendly_name: suffix }
  const seat = {
    agent_id: agent.id,
    session_id: `session:${suffix}`,
    terminal_capability: `terminal:${suffix}`,
  }
  return { librarian, agent, seat }
}

{
  const { librarian, agent, seat } = fixture('login-first')
  let outcome = null
  const readiness = librarian.awaitAcceptedSeat({ id: agent.id, name: agent.friendly_name })
  readiness.then(result => { outcome = result })
  librarian.observeLogin(agent)
  await nextTurn()
  assert.equal(outcome, null, 'generic login resolved spawn before durable seat acceptance')
  librarian.observeSeat(seat)
  assert.deepEqual(await readiness, { ok: true, agent })
}

{
  const { librarian, agent, seat } = fixture('seat-first')
  let outcome = null
  const readiness = librarian.awaitAcceptedSeat({ id: agent.id, name: agent.friendly_name })
  readiness.then(result => { outcome = result })
  librarian.observeSeat(seat)
  await nextTurn()
  assert.equal(outcome, null, 'seat acceptance resolved spawn before process login')
  librarian.observeLogin(agent)
  await nextTurn()
  assert.equal(outcome, null, 'login resolved from a seat observation that was not freshly read back')
  librarian.observeSeat(seat)
  assert.deepEqual(await readiness, { ok: true, agent })
}

{
  const { librarian, agent, seat } = fixture('invalid-seat')
  let resolutions = 0
  const readiness = librarian.awaitAcceptedSeat({ id: agent.id, name: agent.friendly_name })
  readiness.then(() => { resolutions += 1 })
  librarian.observeLogin(agent)
  librarian.observeSeat({ ...seat, agent_id: 'fleet:wrong-agent' })
  librarian.observeSeat({ ...seat, terminal_capability: null })
  await nextTurn()
  assert.equal(resolutions, 0)
  librarian.observeSeat(seat)
  librarian.observeSeat(seat)
  assert.deepEqual(await readiness, { ok: true, agent })
  await nextTurn()
  assert.equal(resolutions, 1, 'duplicate observations resolved readiness more than once')
}

{
  const current = {
    agent_id: 'fleet:readback',
    session_id: 'session:current',
    terminal_capability: 'terminal:current',
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
  const readiness = librarian.awaitAcceptedSeat({ id: agent.id, name: agent.friendly_name })
  readiness.then(result => { outcome = result })

  librarian.observeSeat(readAcceptedCurrentSeat(store, agent.id, seat))
  current = { ...seat, terminal_capability: null }
  librarian.observeLogin(agent)
  const revoked = readAcceptedCurrentSeat(store, agent.id, current)
  if (revoked) librarian.observeSeat(revoked)
  await nextTurn()
  assert.equal(outcome, null, 'login resolved from a terminal capability revoked after seat observation')

  current = { ...seat, terminal_capability: 'terminal:restored' }
  librarian.observeSeat(readAcceptedCurrentSeat(store, agent.id, current))
  assert.deepEqual(await readiness, { ok: true, agent })
}

{
  const { librarian, agent, seat } = fixture('replaced-before-login')
  let current = seat
  const store = { getCurrentAgentSeat: () => current }
  let outcome = null
  const readiness = librarian.awaitAcceptedSeat({ id: agent.id, name: agent.friendly_name })
  readiness.then(result => { outcome = result })

  librarian.observeSeat(readAcceptedCurrentSeat(store, agent.id, seat))
  current = {
    ...seat,
    session_id: 'session:replacement',
    terminal_capability: 'terminal:replacement',
  }
  librarian.observeLogin(agent)
  const stale = readAcceptedCurrentSeat(store, agent.id, seat)
  if (stale) librarian.observeSeat(stale)
  await nextTurn()
  assert.equal(outcome, null, 'login resolved from a replaced current seat')

  librarian.observeSeat(readAcceptedCurrentSeat(store, agent.id, current))
  assert.deepEqual(await readiness, { ok: true, agent })
}

{
  const { librarian, agent } = fixture('login-only-api')
  const readiness = librarian.awaitLogin({ id: agent.id, name: agent.friendly_name })
  librarian.observeLogin(agent)
  assert.deepEqual(await readiness, { ok: true, agent })
}

{
  const librarian = new SpawnLibrarian({ loginDeadlineMs: 5 })
  const agent = { id: 'fleet:acceptance-timeout', friendly_name: 'acceptance-timeout' }
  const readiness = librarian.awaitAcceptedSeat({ id: agent.id, name: agent.friendly_name })
  librarian.observeLogin(agent)
  assert.deepEqual(await readiness, { ok: false, reason: 'acceptance-timeout' })
}

console.log('spawn seat acceptance regression: ok')
