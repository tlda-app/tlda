import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOOSE_END_PROCESS_MSG,
  LOOSE_END_REPORT_MSG,
  decideLooseEndNudge,
  isLooseEndProcessCorrection,
  isLooseEndReport,
} from '../bin/lib/todd-loose-ends.mjs'

const ownerId = 'fleet:skip'
const botId = 'fleet:todd'
const agentId = 'fleet:agent-1'
const now = Date.parse('2026-06-18T10:00:00.000Z')

test('detects agent reports that leave loose ends for Skip', () => {
  assert.equal(isLooseEndReport('The source needs an explicit boundary lemma.'), true)
  assert.equal(isLooseEndReport('Consequences: this is not verified yet.'), true)
  assert.equal(isLooseEndReport('I finished the edit and tests pass.'), false)
})

test('agent loose-end report sends direct nudge to same agent', () => {
  const nudge = decideLooseEndNudge({
    fromId: agentId,
    toId: ownerId,
    text: 'Conclusion: this works unless we prove X.',
    ownerId,
    botId,
    now,
  })

  assert.equal(nudge.agentId, agentId)
  assert.equal(nudge.kind, 'report')
  assert.equal(nudge.message, LOOSE_END_REPORT_MSG)
})

test('detects Skip process corrections and nudges target agent', () => {
  assert.equal(isLooseEndProcessCorrection('Needs a lemma does not mean done.'), true)
  assert.equal(isLooseEndProcessCorrection('Can you work on this direction more proactively?'), true)

  const nudge = decideLooseEndNudge({
    fromId: ownerId,
    toId: agentId,
    text: 'Can you work on this direction more proactively?',
    ownerId,
    botId,
    now,
  })

  assert.equal(nudge.agentId, agentId)
  assert.equal(nudge.kind, 'process')
  assert.equal(nudge.message, LOOSE_END_PROCESS_MSG)
})

test('loose-end nudges respect per-agent cooldown', () => {
  const lastSent = new Map()
  const first = decideLooseEndNudge({
    fromId: agentId,
    toId: ownerId,
    text: 'Status: partial. Remaining: source needs X.',
    ownerId,
    botId,
    now,
    lastSent,
  })
  const second = decideLooseEndNudge({
    fromId: agentId,
    toId: ownerId,
    text: 'Status: still partial. Remaining: source needs Y.',
    ownerId,
    botId,
    now: now + 60_000,
    lastSent,
  })
  const third = decideLooseEndNudge({
    fromId: agentId,
    toId: ownerId,
    text: 'Status: still partial. Remaining: source needs Z.',
    ownerId,
    botId,
    now: now + 130_000,
    lastSent,
  })

  assert.equal(first?.kind, 'report')
  assert.equal(second, null)
  assert.equal(third?.kind, 'report')
})
