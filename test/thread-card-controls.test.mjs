import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { renderActivityGroup, renderThreadRows, semanticOperationDescriptor } from '../src/fleet/activity-render.mjs'

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

function decodeSemanticDescriptor(html) {
  const encoded = html.match(/data-semantic-operation="([^"]+)"/)?.[1]
  return JSON.parse(encoded
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&'))
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

// `me` belongs to the agent who made the recorded call, not the human who later
// reads its card. The descriptor preserves the visible call while carrying that
// lexical environment to the client-side rerun.
test('a thread card keeps its agent caller when a human reads it', () => {
  const caller = 'fleet:agent'
  const html = renderActivityGroup([{
    from: caller,
    timestamp: '2026-08-20T12:00:00.000Z',
    _toolName: 'mcp__tlda__thread',
    _toolInput: { agent: 'skip' },
  }], ctx)
  const descriptor = decodeSemanticDescriptor(html)

  assert.equal(descriptor.caller, caller)
  assert.equal(descriptor.view.agent, 'skip')
  assert.equal(descriptor.arg, '')
  assert.notEqual(descriptor.semanticKey, semanticOperationDescriptor('mcp__tlda__thread', { agent: 'skip' }, '', '2026-08-20T12:00:00.000Z', 'fleet:human').semanticKey)
})

test('a lexical me filter keeps its displayed text', () => {
  const html = renderActivityGroup([{
    from: 'fleet:agent',
    timestamp: '2026-08-20T12:00:00.000Z',
    _toolName: 'mcp__tlda__thread',
    _toolArg: 'me <> skip',
    _toolInput: { filter: 'me <> skip' },
  }], ctx)
  const descriptor = decodeSemanticDescriptor(html)

  assert.equal(descriptor.caller, 'fleet:agent')
  assert.equal(descriptor.filterExpression, 'me <> skip')
  assert.equal(descriptor.view.filter, 'me <> skip')
  assert.match(html, /me &lt;&gt; skip/)
})

test('the thread rerun evaluates me as the recorded caller', () => {
  const source = readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('function threadSearchRequest(')
  const end = source.indexOf('\nfunction semanticSearchRequest(', start)
  const request = source.slice(start, end)

  assert.match(request, /if \(descriptor\?\.caller\) filters\.me = descriptor\.caller/)
})

// Skip, 2026-08-19 05:37 EDT: "the search you just did returned four results.
// Nonetheless, there's a button that says show all results. That does nothing
// other than turn into a collapse button ... If there's nothing to expand, don't
// put a fucking expand button."
//
// A search card shows every result it has. The clipped preview it used to expand
// FROM -- `max-height: 12em` with a fade -- was deleted in 9496c3322 because it
// re-truncated snippets the backend had already truncated; the control outlived
// it. This test replaces one that asserted that deleted rule, and had therefore
// been failing since.
test('a search card renders neither an expand nor a collapse control', () => {
  const html = renderActivityGroup([{
    from: 'fleet:codex',
    timestamp: '2026-08-14T07:05:12.055Z',
    _toolName: 'tool_search',
    _toolArg: 'source edit',
    _toolInput: { query: 'source edit', limit: 20 },
  }], ctx)
  const source = readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')

  assert.match(html, /semantic-search-operation/)
  assert.match(html, /class="semantic-operation-body" data-semantic-operation=/)
  // The card is the whole surface: no expand marker, under any label.
  assert.doesNotMatch(html, /pretty-expand-btn/)
  assert.doesNotMatch(html, /Show all search results/)
  assert.doesNotMatch(html, /semantic-chat-operation-open/)
  // And the collapse is a SECOND control with its own condition, so it goes
  // separately rather than being left to a rule that can no longer fire.
  const start = source.indexOf('function SemanticChatOperationView(')
  const searchView = source.slice(start, source.indexOf('\ntype AnchoredChatListProps', start))
  assert.match(searchView, /<FleetSearchResultsView/)
  assert.equal((searchView.match(/semantic-operation-collapse/g) || []).length, 0)
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

// The expansion has to survive the card being re-rendered under it, and it was
// remembered under a key each side computed by counting siblings: the click
// indexed the button among the ROW's `.pretty-expand-btn`, the restore indexed
// the rows among the VIEW's `.pretty-more-rows`. Those agree only while a row
// holds exactly one expand button -- and a thread whose front rows carry a
// search activity renders a second one, so the marker was written under
// `:pretty:1` and read back under `:pretty:0`. Skip, 8/12 17:15:36 EDT: "I got
// the collapse button, but nothing else changed other than a flicker. So it
// grew instantaneously and then collapsed back."
//
// The pairing is now in the markup, so pin the markup.
test('the gap marker and its rows name each other without counting siblings', () => {
  const html = renderThreadRows(threadRows(1, 16), ctx)

  assert.match(html, /class="pretty-expand-btn" data-fold-id="thread-middle"/)
  assert.match(html, /class="pretty-more-rows" data-fold-id="thread-middle"/)

  // The arrangement that used to shift the key: a search activity ahead of the
  // marker. It contributed the second `.pretty-expand-btn` that made the two
  // sides count differently — this was `2` until the search card's expand
  // control was deleted, having had nothing to expand since 9496c3322. The
  // marker still names its rows in the markup, which is what the key reads, so
  // the pairing does not depend on there being one button or two.
  const withSearch = renderThreadRows([
    { timestamp: '9:00:00 AM', activity: { _toolName: 'mcp__tlda__search', _toolInput: { query: 'x' }, type: 'tool', from: 'a' } },
    ...threadRows(1, 15),
  ], ctx)
  assert.equal((withSearch.match(/pretty-expand-btn/g) || []).length, 1)
  assert.equal((withSearch.match(/data-fold-id="thread-middle"/g) || []).length, 2)
})

// Two thread cards merged into one chat row must not share a fold, so the key
// carries the card's own semantic key. The bare mount point is still bare of a
// shell -- this is an identifier, not a control.
test('a thread mount point carries its semantic key', () => {
  const source = readFileSync(new URL('../src/fleet/activity-render.mjs', import.meta.url), 'utf8')
  assert.match(source, /class="semantic-operation-body" data-semantic-key="\$\{key\}"/)
})

// One function, called by both sides. Two call sites computing a key
// independently is what broke, and a second implementation would break it the
// same way whatever the markup says.
test('the click and the restore compute the fold key with the same function', () => {
  const source = readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
  assert.equal((source.match(/prettyFoldKey\(itemKey, /g) || []).length, 2)
  assert.doesNotMatch(source, /`\$\{itemKey\}:pretty:\$\{i\}`/)
})

// The two sides start from different elements -- the click holds the button,
// the restore holds the rows -- and reach the key through different roots. Run
// the real function over the real markup from both ends and from both roots.
test('the button and the rows resolve to one key, whatever is rendered around them', async () => {
  const { JSDOM } = await import('jsdom')
  const { prettyFoldKey } = await import('../src/shapes/fleet-chat-fold-key.mjs')

  const card = (rows) => `<div class="semantic-operation-body" data-semantic-key="T1">${renderThreadRows(rows, ctx)}</div>`
  const searchActivity = { timestamp: '9:00:00 AM', activity: { _toolName: 'mcp__tlda__search', _toolInput: { query: 'x' }, type: 'tool', from: 'a' } }

  for (const [label, rows] of [
    ['plain thread', threadRows(1, 16)],
    ['a search activity ahead of the marker', [searchActivity, ...threadRows(1, 15)]],
  ]) {
    const dom = new JSDOM(`<div data-item-key="row-7">${card(rows)}</div>`)
    const row = dom.window.document.querySelector('[data-item-key]')
    const view = dom.window.document.querySelector('.semantic-operation-body')
    const btn = view.querySelector('.pretty-expand-btn[data-fold-id="thread-middle"]')
    const moreRows = view.querySelector('.pretty-more-rows')

    // What the click writes, indexing across the whole row.
    const allBtns = [...row.querySelectorAll('.pretty-expand-btn')]
    const written = prettyFoldKey('row-7', btn, Math.max(0, allBtns.indexOf(btn)))
    // What the restore reads, from the view and from the row -- both callers.
    const fromView = prettyFoldKey('row-7', moreRows, [...view.querySelectorAll('.pretty-more-rows')].indexOf(moreRows))
    const fromRow = prettyFoldKey('row-7', moreRows, [...row.querySelectorAll('.pretty-more-rows')].indexOf(moreRows))

    assert.equal(written, fromView, label)
    assert.equal(written, fromRow, label)
    assert.equal(written, 'row-7:pretty:T1:thread-middle', label)
  }
})

// And two thread cards in one row do not share a fold.
test('merged thread cards keep separate folds', async () => {
  const { JSDOM } = await import('jsdom')
  const { prettyFoldKey } = await import('../src/shapes/fleet-chat-fold-key.mjs')

  const dom = new JSDOM(`<div data-item-key="row-7">
    <div class="semantic-operation-body" data-semantic-key="T1">${renderThreadRows(threadRows(1, 16), ctx)}</div>
    <div class="semantic-operation-body" data-semantic-key="T2">${renderThreadRows(threadRows(1, 16), ctx)}</div>
  </div>`)
  const [a, b] = [...dom.window.document.querySelectorAll('.pretty-more-rows')]
  assert.notEqual(prettyFoldKey('row-7', a, 0), prettyFoldKey('row-7', b, 1))
})

// A tap makes the browser send its own click after the one we re-dispatch, for
// any element it treats as clickable -- not only the <button> targets the
// re-dispatch excludes. Both ran, so every toggle undid itself on iPad and pen.
// The follow-up is swallowed above the target, which is what keeps it away from
// the code-block fold's inline onclick as well as this handler.
test('the re-dispatched tap does not leave a second click behind', () => {
  const source = readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')

  assert.match(source, /redispatchedTapTarget = hit\s*\n\s*hit\.click\(\)/)
  assert.match(source, /const onClickCapture = \(e: MouseEvent\) => \{/)
  // Capture phase, or it arrives after the inline handler it has to stop.
  assert.match(source, /addEventListener\('click', onClickCapture, true\)/)
  assert.match(source, /removeEventListener\('click', onClickCapture, true\)/)
  // Only the browser's own follow-up, never our re-dispatch.
  assert.match(source, /if \(!e\.isTrusted \|\| Date\.now\(\) >= redispatchedTapUntil\) return/)
})
