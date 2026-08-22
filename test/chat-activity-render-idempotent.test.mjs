import assert from 'node:assert/strict'
import test from 'node:test'

import { renderActivityGroup, renderEditDiff, renderCodeCard } from '../src/fleet/activity-render.mjs'

// Rendering is a pure function of its inputs, and the chat panel depends on that
// being true rather than merely usually true.
//
// `ChatMessageRow` writes these strings with `dangerouslySetInnerHTML`. React
// compares the string it is given against the previous one and touches the DOM
// only when they differ. So a renderer that returns a different string for the
// same input makes every re-render destroy and rebuild the row's subtree —
// which throws away the activity card, its expand state, and the
// `browserMountedAtMs` stamp, for no change in what the row says.
//
// The panel re-renders constantly: `rawItems` depends on `ctx`, `agentById` and
// twelve other values that move whenever any agent in the fleet does anything.
// Cached groups are safe because the cache returns the same string; anything
// that misses the cache is re-rendered, and before this test three ids in this
// file were `Math.random()`, so a miss could never produce an identical string.
//
// Measured on Skip's own tab on 2026-08-22: activity cards whose `data-msg-id`
// was unchanged received new `browserMountedAtMs` stamps five times, 3-4 cards
// at once, always one agent's cards while other agents' cards were untouched.
// Every member here is deterministic on purpose: if the fixture varied, a
// failure would not distinguish a non-deterministic renderer from a
// non-deterministic test.
const ctx = {
  agentLabel: id => id,
  getNickClass: () => 'nick-agent-0',
  getAgents: () => [],
  getTasks: () => [],
  renderMarkdown: html => html,
  langFromFilePath: path => (path.endsWith('.js') ? 'javascript' : ''),
  highlightSyntax: code => code,
  preambleMacros: {},
}

test('renderActivityGroup returns the same html for the same group', () => {
  const group = [
    {
      from: 'fleet:7235a911',
      timestamp: '2026-08-22T05:47:31.090Z',
      _dbId: 3170487,
      _toolName: 'Bash',
      _toolArg: 'df -h',
      _toolInput: { command: 'df -h' },
    },
    {
      from: 'fleet:7235a911',
      timestamp: '2026-08-22T05:47:33.000Z',
      _dbId: 3170488,
      _isText: true,
      _text: 'checking disk',
    },
  ]

  const first = renderActivityGroup(group, ctx)
  const second = renderActivityGroup(group, ctx)

  assert.equal(first, second)
})

test('renderEditDiff returns the same html for the same input', () => {
  const input = {
    file_path: 'src/example.js',
    old_string: 'const a = 1',
    new_string: 'const a = 2',
  }

  assert.equal(renderEditDiff(input, ctx), renderEditDiff(input, ctx))
})

// Stable is only half of it. Two different cards must still get different ids,
// or the fix trades a needless rebuild for duplicate ids in one document.
test('different groups get different card ids', () => {
  const groupFor = dbId => [{
    from: 'fleet:7235a911',
    timestamp: '2026-08-22T05:47:31.090Z',
    _dbId: dbId,
    _toolName: 'Bash',
    _toolArg: 'df -h',
    _toolInput: { command: 'df -h' },
  }]

  const idOf = html => html.match(/data-card-id="([^"]+)"/)?.[1]
  const first = idOf(renderActivityGroup(groupFor(3170487), ctx))
  const second = idOf(renderActivityGroup(groupFor(3170488), ctx))

  assert.ok(first, 'expected a card id to be rendered')
  assert.notEqual(first, second)
})

test('different edits get different diff ids', () => {
  const idOf = html => html.match(/id="(diff-[^"]+)"/)?.[1]
  const first = idOf(renderEditDiff({ file_path: 'a.js', old_string: 'x', new_string: 'y' }, ctx))
  const second = idOf(renderEditDiff({ file_path: 'a.js', old_string: 'x', new_string: 'z' }, ctx))

  assert.ok(first, 'expected a diff id to be rendered')
  assert.notEqual(first, second)
})

test('renderCodeCard returns the same html for the same input', () => {
  const input = {
    file_path: 'paper/section.tex',
    content: Array.from({ length: 40 }, (_, i) => `\\text{line ${i}}`).join('\n'),
  }

  assert.equal(renderCodeCard('Write', input, ctx), renderCodeCard('Write', input, ctx))
})
