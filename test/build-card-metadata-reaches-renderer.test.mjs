import assert from 'node:assert/strict'
import test from 'node:test'

import { convertChatEvent } from '../src/fleet/convert-chat-event.mjs'

// The build card is drawn by FleetChatShape's `m.metadata?.type ===
// 'build_result'` branch, and `m` is whatever convertChatEvent returned. That
// converter is an allowlist, `type` was not on it, and so the branch could not
// be reached by any event and had never run once: every build card rendered as
// the ordinary text line `Build <hash> — <project>`.
//
// This is the silent-and-destructive class — the card was emitted, stored,
// delivered and never seen, with every end reporting health. So the property
// under test is the step BETWEEN the ends: what the store holds still says
// `build_result` by the time the renderer reads it.
//
// The event is shaped as the store hands it over — metadata as a JSON STRING,
// which is the DB path — rather than as an object, because that parse is part
// of what is being exercised.
const storedBuildCardEvent = () => ({
  id: 4242,
  type: 'chat',
  from_id: 'fleet:tlda',
  recipients: ['fleet:someone'],
  text: 'Build 1c600c9 — a-project',
  timestamp: '2026-09-12T21:00:00.000Z',
  metadata: JSON.stringify({
    type: 'build_result',
    name: 'a-project',
    hash: '1c600c9',
    summary: 'Rewrote one paragraph.',
    lintFindings: [{ source: 'prose', text: 'a finding' }],
    mirrorFailed: null,
    buildFailed: null,
    errors: [],
    warnings: [],
  }),
})

test('a stored build card still says build_result when the renderer reads it', () => {
  const m = convertChatEvent(storedBuildCardEvent())
  // The renderer's own condition, verbatim from FleetChatShape.
  assert.equal(m.metadata?.type, 'build_result')
})

test('the card carries the fields it draws itself from', () => {
  const m = convertChatEvent(storedBuildCardEvent())
  // Every one of these is destructured off m.metadata by the card branch. A
  // card that arrives without them renders as an empty frame, which would look
  // like a styling bug rather than a lost payload.
  const { name, hash, summary, lintFindings, mirrorFailed, buildFailed, errors } = m.metadata
  assert.equal(name, 'a-project')
  assert.equal(hash, '1c600c9')
  assert.equal(summary, 'Rewrote one paragraph.')
  assert.equal(lintFindings.length, 1)
  assert.equal(mirrorFailed, null)
  assert.equal(buildFailed, null)
  assert.deepEqual(errors, [])
})

test('a failed build keeps the message the red card prints', () => {
  const failed = storedBuildCardEvent()
  failed.text = '❌ Build failed — a-project: LaTeX produced no DVI'
  failed.metadata = JSON.stringify({
    type: 'build_result',
    name: 'a-project',
    hash: null,
    buildFailed: 'LaTeX produced no DVI',
    errors: [{ message: 'Undefined control sequence' }],
    lintFindings: [],
  })
  const m = convertChatEvent(failed)
  assert.equal(m.metadata?.type, 'build_result')
  assert.equal(m.metadata.buildFailed, 'LaTeX produced no DVI')
  assert.equal(m.metadata.errors[0].message, 'Undefined control sequence')
})

// The control. Without it these tests pass just as well against a converter
// that copies every metadata key of every event onto the message, which is a
// different change with a different blast radius — the allowlist is deliberate
// and the comment at the top of that file says so.
test('an ordinary chat message is not turned into a card', () => {
  const m = convertChatEvent({
    id: 4243,
    type: 'chat',
    from_id: 'fleet:someone',
    recipients: ['fleet:skip'],
    text: 'ordinary message',
    timestamp: '2026-09-12T21:01:00.000Z',
    metadata: JSON.stringify({ type: 'something_else', name: 'a-project' }),
  })
  assert.notEqual(m.metadata?.type, 'build_result')
  assert.equal(m.metadata?.name, undefined)
})
