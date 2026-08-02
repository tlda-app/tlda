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

// The rows are the picture: first 5, the gap marker, the last 3, and one
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

// Skip: "five lines up top expand thing three lines below." The split was 3 and
// 5 -- the right shape with the ends swapped, which reads wrong on a card you
// scan top-down. Pin the sizes, not just their sum: 16 messages hides 8 either
// way, so the count alone cannot tell the two apart.
test('the range shows five on top and three below', () => {
  const html = renderThreadRows(threadRows(1, 16), ctx)
  const head = html.slice(0, html.indexOf('pretty-expand-btn'))
  const hidden = html.slice(html.indexOf('pretty-more-rows'))
  // The hidden middle ends at the last message it holds; the tail is what the
  // card still draws after it.
  const tail = hidden.slice(hidden.indexOf('message 13'))

  assert.equal((head.match(/class="chat-line/g) || []).length, 5)
  for (const n of [1, 2, 3, 4, 5]) assert.match(head, new RegExp(`message ${n}\\b`))
  assert.doesNotMatch(head, /message 6\b/)

  assert.equal((tail.match(/class="chat-line/g) || []).length, 3)
  for (const n of [14, 15, 16]) assert.match(tail, new RegExp(`message ${n}\\b`))
})

// Expand reveals the middle out of the rows already drawn, so every message the
// read returned is present -- no second ellipsis, and no bound from whatever a
// pretty result happened to carry.
test('the hidden middle is present, not another ellipsis', () => {
  const html = renderThreadRows(threadRows(1, 16), ctx)
  const middle = html.slice(html.indexOf('pretty-more-rows'))
  for (const n of [6, 7, 8, 9, 10, 11, 12, 13]) assert.match(middle, new RegExp(`message ${n}\\b`))
})

// Skip: "it's supposed to fucking render threads at ... 16 lines tall. With a
// fucking expand button, but it's rendering them like arbitrarily fucking tall."
// Skip, on the card that clipped itself and expanded on a click: "there's no
// fucking expand button... It's literally click to expand to something you can
// expand." One expand, and it is the gap marker.
test('the card has no height bound and no click of its own', () => {
  for (const thread of [0, 16]) {
    const html = renderThreadRows(threadRows(1, 16), { ...ctx, foldHeights: { thread } })
    assert.doesNotMatch(html, /max-height/)
    assert.doesNotMatch(html, /onclick=/)
    assert.equal((html.match(/pretty-expand-btn/g) || []).length, 1)
  }
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
