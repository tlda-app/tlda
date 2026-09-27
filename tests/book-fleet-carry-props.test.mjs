import test from 'node:test'
import assert from 'node:assert/strict'
import { FLEET_CARRY_PROP_ALLOWLIST, carriedPropsFor } from '../src/bookFleetCarryProps.ts'

// Teleport carry is default-deny on panel props: ownership and geometry are
// handled by the mechanism, and only room-independent panel state crosses.
// Doc-bound content (docview position, source-editor file) resets to defaults
// in the new room instead of pointing at the old chapter.

test('chat carries its fleet-scoped filter, nothing else', () => {
  const filter = [[['from', 'skip']]]
  assert.deepEqual(
    carriedPropsFor('fleet-chat', { filter, query: 'q', userId: 'u', deviceId: 'd', w: 1, page: 3 }),
    { filter, query: 'q' },
  )
})

test('search carries its query', () => {
  assert.deepEqual(carriedPropsFor('fleet-search', { query: 'layers', mode: 'x' }), { query: 'layers' })
})

test('video carries its live tiles and title', () => {
  assert.deepEqual(
    carriedPropsFor('fleet-video', { tileKeys: '["a"]', title: 'Call', w: 1 }),
    { tileKeys: '["a"]', title: 'Call' },
  )
})

test('report artifact carries its url and title', () => {
  assert.deepEqual(
    carriedPropsFor('fleet-report-artifact', { url: 'https://x/r', title: 'R', w: 1 }),
    { url: 'https://x/r', title: 'R' },
  )
})

test('docview carries no content props', () => {
  assert.deepEqual(
    carriedPropsFor('fleet-docview', { sources: '["ref"]', mode: 'manual', page: 3, yTop: 10, yBottom: 50, title: 'T' }),
    {},
  )
})

test('source editor carries no file position', () => {
  assert.deepEqual(
    carriedPropsFor('fleet-source-editor', { file: 'content.md', line: 40, title: 'Source' }),
    {},
  )
})

test('agents, inbox, and notifications carry geometry only', () => {
  for (const type of ['fleet-agents', 'fleet-inbox', 'fleet-notifications']) {
    assert.deepEqual(carriedPropsFor(type, { segments: ['a'], w: 1 }), {})
  }
})

test('unknown panel types carry nothing', () => {
  assert.deepEqual(carriedPropsFor('fleet-future', { anything: 1 }), {})
  assert.ok(!('fleet-future' in FLEET_CARRY_PROP_ALLOWLIST))
})
