import assert from 'node:assert/strict'
import test from 'node:test'

import { renderActivityGroup, renderThreadRows } from '../src/fleet/activity-render.mjs'

const ctx = {
  agentLabel: id => id,
  getNickClass: () => 'nick-agent-0',
  getAgents: () => [],
  getTasks: () => [],
  renderMarkdown: html => html,
}

function threadRows(start, count) {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: `9:${String(start + i).padStart(2, '0')}:00 AM`,
    from: 'skip',
    to: 'pretty',
    body: `message ${start + i}`,
  }))
}

// The rows are the picture: first 3, the gap marker, the last 5, and one
// control. Skip: "they were supposed to render literally the same thing out of
// the database... so they're not supposed to fucking have changed the UI."
test('a long thread draws the picture: front, gap marker, tail, one control', () => {
  const html = renderThreadRows(threadRows(1, 16), ctx)

  assert.match(html, /tool-pretty-thread/)
  assert.match(html, /message 1\b/)
  assert.match(html, /message 16\b/)
  assert.match(html, /pretty-more-rows/)
  assert.match(html, /… 8 messages …/)
  assert.equal((html.match(/pretty-expand-btn/g) || []).length, 1)
})

// Expand reveals the middle out of the rows already drawn, so every message the
// read returned is present -- no second ellipsis, and no bound from whatever a
// pretty result happened to carry.
test('the hidden middle is present, not another ellipsis', () => {
  const html = renderThreadRows(threadRows(1, 16), ctx)
  const middle = html.slice(html.indexOf('pretty-more-rows'))
  for (const n of [4, 5, 6, 7, 8, 9, 10, 11]) assert.match(middle, new RegExp(`message ${n}\\b`))
})

// Skip: "it's supposed to fucking render threads at ... 16 lines tall. With a
// fucking expand button, but it's rendering them like arbitrarily fucking tall."
test('the card is bounded by the fold setting, and 0 means never fold', () => {
  const bounded = renderThreadRows(threadRows(1, 16), { ...ctx, foldHeights: { thread: 16 } })
  assert.match(bounded, /pretty-thread-bounded/)
  assert.match(bounded, /max-height:24\.0em/)
  // The bound clips behind an expand control. A scrollbar is not the button he
  // asked for: "some agent made it fixed height fucking scrolling."
  assert.match(bounded, /pretty-thread-clipped/)
  assert.match(bounded, /pretty-thread-expand/)

  const unbounded = renderThreadRows(threadRows(1, 16), { ...ctx, foldHeights: { thread: 0 } })
  assert.doesNotMatch(unbounded, /pretty-thread-bounded/)
  assert.doesNotMatch(unbounded, /max-height/)
  assert.doesNotMatch(unbounded, /pretty-thread-expand/)
})

// The search card's shell -- its open/collapse button and its "inspected" line
// -- was never part of the thread picture. The mount point is bare.
test('a thread card carries no semantic-operation shell', () => {
  const html = renderActivityGroup([
    {
      from: 'fleet:pretty',
      timestamp: '2026-07-30T13:33:41.000Z',
      _toolName: 'mcp__tlda__thread',
      _toolArg: 'agent:pretty',
      _toolInput: { agent: 'pretty', page_size: 8 },
      _prettyResult: '[9:01:00 AM] skip → pretty\nmessage 1',
    },
  ], ctx)

  assert.equal((html.match(/semantic-chat-operation/g) || []).length, 0)
  assert.equal((html.match(/semantic-operation-inspected/g) || []).length, 0)
  assert.match(html, /semantic-operation-body/)
})
