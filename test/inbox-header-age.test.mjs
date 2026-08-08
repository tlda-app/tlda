import assert from 'node:assert/strict'
import test from 'node:test'
import { formatInboxText, inboxAgeSpan } from '../mcp-server/fleet-tools.mjs'

const NOW = Date.parse('2026-08-08T18:00:00.000Z')
const at = iso => ({ id: Math.random(), kind: 'message', line: 'x', timestamp: iso })
const page = [at('2026-08-08T14:00:00Z'), at('2026-08-08T14:30:00Z'), at('2026-08-08T15:10:00Z')]
const truncated = { messages: 256, tasks: 0, messages_truncated: true, newest_unread_at: '2026-08-08T17:58:00Z' }

const header = out => out.split('\n').find(l => l.startsWith('Page-limited:'))

test('the span reports both ends, in real units', () => {
  const out = formatInboxText({ mode: 'default', messages: page, counts: truncated, now: NOW })
  assert.equal(header(out), 'Page-limited: 3/256 unread messages shown; oldest shown 4h ago, newest unshown 2m ago.')
})

test('without newest_unread_at it reports only what it knows — no invented number', () => {
  const counts = { ...truncated, newest_unread_at: null }
  const out = formatInboxText({ mode: 'default', messages: page, counts, now: NOW })
  assert.equal(header(out), 'Page-limited: 3/256 unread messages shown; oldest shown 4h ago.')
  assert.doesNotMatch(header(out), /unshown/)
})

test('an untruncated inbox gains no header', () => {
  const counts = { messages: 3, tasks: 0, messages_truncated: false }
  const out = formatInboxText({ mode: 'default', messages: page, counts, now: NOW })
  assert.equal(header(out), undefined)
})

test('the span is additive — the count clause is untouched', () => {
  const out = header(formatInboxText({ mode: 'default', messages: page, counts: truncated, now: NOW }))
  assert.ok(out.startsWith('Page-limited: 3/256 unread messages shown;'))
})

test('a truncated inbox is byte-identical apart from the added span', () => {
  const out = header(formatInboxText({ mode: 'default', messages: page, counts: truncated, now: NOW }))
  const shipped = 'Page-limited: 3/256 unread messages shown.'
  assert.notEqual(out, shipped, 'the span must actually change the output')
  assert.equal(out.replace('; oldest shown 4h ago, newest unshown 2m ago', ''), shipped)
})

test('age thresholds: just now / m / h / d', () => {
  const span = iso => inboxAgeSpan([at(iso)], null, NOW)
  assert.equal(span('2026-08-08T17:59:30Z'), 'oldest shown just now')
  assert.equal(span('2026-08-08T17:30:00Z'), 'oldest shown 30m ago')
  assert.equal(span('2026-08-08T12:00:00Z'), 'oldest shown 6h ago')
  assert.equal(span('2026-08-05T18:00:00Z'), 'oldest shown 3d ago')
})

test('oldest is the minimum of the page, not its first row', () => {
  const shuffled = [at('2026-08-08T15:10:00Z'), at('2026-08-08T14:00:00Z')]
  assert.match(inboxAgeSpan(shuffled, null, NOW), /oldest shown 4h ago/)
})
