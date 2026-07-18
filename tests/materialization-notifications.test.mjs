import assert from 'node:assert/strict'
import test from 'node:test'

import { formatMaterializationFailureNotification } from '../server/lib/materialization-notifications.mjs'

test('aggregates shared-reason attachment failures into one compact result', () => {
  const text = formatMaterializationFailureNotification({
    eventId: 1391286,
    failures: [
      { attachment: { id: 0, name: 'one.json' }, record: { error: 'agent has no daemon address' } },
      { attachment: { id: 1, name: 'two.mjs' }, record: { error: 'agent has no daemon address' } },
      { attachment: { id: 2, name: 'README.md' }, record: { error: 'agent has no daemon address' } },
    ],
  })
  assert.equal(text, [
    '3 attachments failed to materialize for message 1391286:',
    '- one.json',
    '- two.mjs',
    '- README.md',
    '',
    'Reason: agent has no daemon address',
  ].join('\n'))
})

test('lists per-file reasons when a batch fails differently', () => {
  const text = formatMaterializationFailureNotification({
    eventId: 42,
    failures: [
      { attachment: { name: 'one.md' }, record: { error: 'route missing' } },
      { attachment: { name: 'two.png' }, record: { error: 'checksum mismatch' } },
    ],
  })
  assert.equal(text, [
    '2 attachments failed to materialize for message 42:',
    '- one.md — route missing',
    '- two.png — checksum mismatch',
  ].join('\n'))
})

test('preserves the existing single-failure wording', () => {
  assert.equal(formatMaterializationFailureNotification({
    eventId: 7,
    failures: [{ attachment: { name: 'only.tex' }, record: { error: 'offline' } }],
  }), 'Attachment materialization failed for message 7: only.tex\noffline')
})

test('emits nothing for a successful batch', () => {
  assert.equal(formatMaterializationFailureNotification({ eventId: 7, failures: [] }), null)
})
