import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')

function reconcileBody() {
  const start = source.indexOf('async function reconcileActivityHealthIncident(')
  assert.notEqual(start, -1, 'reconcileActivityHealthIncident should exist')
  const end = source.indexOf('async function updateAgentActivityHealth(', start)
  assert.notEqual(end, -1, 'updateAgentActivityHealth should follow the reconcile')
  return source.slice(start, end)
}

test('activity-health transitions never chat a human; incident state stays in metadata', () => {
  const body = reconcileBody()
  // 2026-09-26: transition reports (watcher flaps that self-clear in a
  // second, per-agent fan-out on routine daemon restarts, incidents about
  // long-idle agents) fired critical chats to Skip with no true-positive
  // capacity. Neither the raise nor the clear chats; the metadata record
  // remains the state that operators and projections read.
  assert.doesNotMatch(body, /reportFleetIncident\(/, 'raise must not chat a human')
  assert.doesNotMatch(body, /reportFleetIncidentClear\(/, 'clear must not chat a human')
  assert.match(body, /updateAgentActivityHealthIncidents/, 'metadata records stay')
})
