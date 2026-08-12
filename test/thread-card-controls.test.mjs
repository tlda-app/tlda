import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

// The rows are the picture: first 3, the gap marker, the last 2, and one
// control. Skip: "they were supposed to render literally the same thing out of
// the database... so they're not supposed to fucking have changed the UI."
test('a long thread draws the picture: front, gap marker, tail, one control', () => {
  const html = renderThreadRows(threadRows(1, 16), ctx)

  assert.match(html, /tool-pretty-thread/)
  assert.match(html, /message 1\b/)
  assert.match(html, /message 16\b/)
  assert.match(html, /pretty-more-rows/)
  assert.match(html, /… 11 messages …/)
  assert.equal((html.match(/pretty-expand-btn/g) || []).length, 1)
})

// Skip, having seen five and three on screen: "it can't be five messages, it's
// gotta be like three, two." Pin the two sizes, not their sum -- a total alone
// cannot tell one split from another.
test('the range shows three on top and two below', () => {
  const html = renderThreadRows(threadRows(1, 16), ctx)
  const head = html.slice(0, html.indexOf('pretty-expand-btn'))
  const hidden = html.slice(html.indexOf('pretty-more-rows'))
  // The hidden middle ends at the last message it holds; the tail is what the
  // card still draws after it.
  const tail = hidden.slice(hidden.indexOf('message 14'))

  assert.equal((head.match(/class="chat-line/g) || []).length, 3)
  for (const n of [1, 2, 3]) assert.match(head, new RegExp(`message ${n}\\b`))
  assert.doesNotMatch(head, /message 4\b/)

  assert.equal((tail.match(/class="chat-line/g) || []).length, 2)
  for (const n of [15, 16]) assert.match(tail, new RegExp(`message ${n}\\b`))
})

// Skip: "we can make it a preference, like, how many messages." The defaults are
// what he settled on; the card reads whatever the user set.
test('the range sizes come from the preference when set', () => {
  const html = renderThreadRows(threadRows(1, 16), { ...ctx, threadRange: { front: 1, tail: 1 } })
  const head = html.slice(0, html.indexOf('pretty-expand-btn'))

  assert.match(html, /… 14 messages …/)
  assert.equal((head.match(/class="chat-line/g) || []).length, 1)
  assert.match(head, /message 1\b/)
  assert.doesNotMatch(head, /message 2\b/)
})

// Expand reveals the middle out of the rows already drawn, so every message the
// read returned is present -- no second ellipsis, and no bound from whatever a
// pretty result happened to carry.
test('the hidden middle is present, not another ellipsis', () => {
  const html = renderThreadRows(threadRows(1, 16), ctx)
  const middle = html.slice(html.indexOf('pretty-more-rows'))
  for (const n of [6, 7, 8, 9, 10, 11, 12, 13]) assert.match(middle, new RegExp(`message ${n}\\b`))
})

// Expanded thread cards render the messages as normal chat content. The only
// thread-level fold is the middle row marker; individual message bodies do not
// carry an independent max-height that survives expansion.
test('the card and its message bodies have no height bound or click of their own', () => {
  for (const thread of [0, 16]) {
    const html = renderThreadRows(threadRows(1, 16), { ...ctx, foldHeights: { thread } })
    const cardTag = html.slice(0, html.indexOf('>') + 1)

    assert.match(cardTag, /tool-pretty-thread/)
    assert.doesNotMatch(cardTag, /max-height/)
    assert.doesNotMatch(html, /max-height/)
    assert.doesNotMatch(html, /thread-msg-collapsed/)
    assert.doesNotMatch(html, /onclick=/)
    assert.equal((html.match(/pretty-expand-btn/g) || []).length, 1)
  }
})

test('thread message bodies do not use the removed more-control path', () => {
  const source = readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
  const html = renderThreadRows(threadRows(1, 2), { ...ctx, foldHeights: { thread: 16 } })

  assert.doesNotMatch(html, /pretty-msg-body-more/)
  assert.doesNotMatch(html, />\[more\]</)
  assert.doesNotMatch(source, /pretty-msg-body-more/)
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

test('a long bash tool call labels the card once', () => {
  const html = renderActivityGroup([
    {
      from: 'fleet:pretty',
      timestamp: '2026-08-12T04:35:15.000Z',
      _toolName: 'Bash',
      _toolArg: 'printf',
      _toolInput: { command: 'printf "one"\nprintf "two"\nprintf "three"' },
    },
  ], {
    ...ctx,
    highlightSyntax: value => value,
    foldHeights: { bash: 10 },
  })

  assert.equal((html.match(/class="tool-name">Bash<\/span>/g) || []).length, 1)
  assert.equal((html.match(/class="code-block-lang">bash<\/span>/g) || []).length, 0)
  assert.match(html, /data-lang="bash"/)
})

// The renderer test above cannot see the control wrapped around its HTML. That
// was the exact hole which let a green suite ship Collapse on every collapsed
// card. Skip, 8/02 12:25:11 PM EDT, correcting himself on the next line: "your
// collapse button should be invisible when the card isn't collapsed." / "When
// the card is collapsed,"
//
// Pin the mechanism that ships. Visibility is a CSS rule keyed on
// `thread-middle-open`, set on the shell by the expand click, the restore pass
// and the collapse itself (2a05017cd). 7020b5117 added a SECOND mechanism for
// the same fact -- a `middleOpen` React state -- and 45d25909c deleted it
// because the re-render landed on DOM the click handler had already mutated, so
// the card snapped shut and left Collapse floating beside a collapsed card:
// the very thing this test exists to prevent. Asserting the React branch would
// require that duplicate back, so assert the rule and the class it keys on.
test('a collapsed thread does not render the floating collapse control', () => {
  const source = readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('function ThreadChatOperationView(')
  const end = source.indexOf('\nfunction SemanticChatOperationView(', start)
  const component = source.slice(start, end)
  const css = readFileSync(new URL('../src/shapes/fleet-chat.css', import.meta.url), 'utf8')

  // One control, and it lives on the thread shell the CSS rule selects.
  assert.equal((component.match(/semantic-operation-collapse/g) || []).length, 1)
  assert.match(component, /thread-shell/)
  // Hidden on a thread card by default; drawn only while the middle is open.
  assert.match(css, /\.thread-shell > \.semantic-operation-collapse\s*\{\s*display:\s*none/)
  assert.match(css, /\.thread-shell\.thread-middle-open > \.semantic-operation-collapse\s*\{\s*display:\s*block/)
  // And that class is actually toggled, or the rule above is decoration.
  assert.match(component, /thread-middle-open/)
})
