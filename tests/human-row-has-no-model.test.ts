// "why am i listed as a sonnet agent" — Skip, 2026-09-19, looking at his own
// row. Nothing had set a model on him; the panel supplied one.
//
// The inference is right and stays: a blank model on an AGENT means the mint
// took the daemon default, which was `sonnet` for the pre-2026-08-23
// population, and showing a dash hid the one fact he asked for
// ("I NEVER FUCKING WANT TO WORK WITH SONNET AGENTS", 2026-08-23).
//
// It is an inference about agents. A human's model is not blank because a
// default filled it — humans are not minted and have no model — so reading
// `sonnet` off the default is false rather than merely dim. These tests pin
// both halves, because fixing the second by deleting the first would put back
// the bug he asked for the column to solve.

import test from 'node:test'
import assert from 'node:assert/strict'

import { toFleetAgentDirectoryRow } from '../src/shapes/FleetAgentDirectoryModel'

const SEEN = '2026-09-19T21:00:00.000Z'

test('a human row carries the human flag and no model', () => {
  const row = toFleetAgentDirectoryRow({
    id: 'fleet:skip', friendly_name: 'skip', human: 1, last_seen: SEEN, metadata: { kind: 'claude' },
  })
  assert.equal(row.human, true, 'the row must know, or the cell cannot tell')
  assert.equal(row.model, '', 'nothing set a model on him and nothing should invent one')
})

test('an agent with no recorded model still infers the daemon default', () => {
  // The half that must NOT regress: this is the column he asked for.
  const row = toFleetAgentDirectoryRow({
    id: 'fleet:abc', friendly_name: 'worker', human: 0, last_seen: SEEN, metadata: {},
  })
  assert.equal(row.human, false)
  assert.equal(row.model, '', 'blank in the row — the cell is what reads sonnet off the default')
})

test('an agent with a recorded model keeps it', () => {
  const row = toFleetAgentDirectoryRow({
    id: 'fleet:def', friendly_name: 'worker2', human: 0, last_seen: SEEN, metadata: { model: 'opus' },
  })
  assert.equal(row.human, false)
  assert.match(row.model, /opus/i)
})

test('a human with a model recorded anyway is still not an agent', () => {
  // Defensive: `metadata.kind` and stray fields have been observed on his human
  // row, so the flag must come from `human`, not from the absence of a model.
  const row = toFleetAgentDirectoryRow({
    id: 'fleet:skip', friendly_name: 'skip', human: 1, last_seen: SEEN, metadata: { model: 'opus' },
  })
  assert.equal(row.human, true)
})
