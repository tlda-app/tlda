import assert from 'node:assert/strict'
import test from 'node:test'

// Mirrors the unquote-file route's offset rewrite in server/routes/fleet.mjs:
// after bumping new attachment ids by the existing count, the tokens in
// resolvedMessage must be rewritten by the same offset so they still point
// at the right entries. New image refs use image#N; legacy tokens keep
// their {{att:N}} rewrite for stored messages.
function applyUnquoteOffset(resolvedMessage, offset) {
  return resolvedMessage
    .replace(/image#(\d+)/g, (_, idx) => `image#${+idx + offset}`)
    .replace(/\{\{att:(\d+)\}\}/g, (_, idx) => `{{att:${+idx + offset}}}`)
}

test('unquote offset keeps legacy tokens aligned', () => {
  assert.equal(
    applyUnquoteOffset('see {{att:0}} and {{att:1}}', 2),
    'see {{att:2}} and {{att:3}}'
  )
})

test('unquote offsets the new image# form', () => {
  assert.equal(
    applyUnquoteOffset('See ![plot](image#0).', 2),
    'See ![plot](image#2).'
  )
})

test('LaTeX dollars in the message pass through untouched', () => {
  assert.equal(
    applyUnquoteOffset('cost $5 and $& then ![plot](image#0)', 2),
    'cost $5 and $& then ![plot](image#2)'
  )
})
