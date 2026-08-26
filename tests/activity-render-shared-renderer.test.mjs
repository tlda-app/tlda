/**
 * Reader text renders the same wherever it appears.
 *
 * Skip, 2026-08-25: "re chat render, i was seeing `\(` and `\[ ` not get
 * rendered in, at least, like edit tool calls", and then the requirement:
 * "gotta make sure we're using the same rendering code throughout so everything
 * works everywhere."
 *
 * `\(…\)` and `\[…\]` are the probe on every path here, because they are what he
 * saw fail — a delimiter chat accepts and a card did not. The other half of the
 * requirement matters just as much and is asserted too: code stays code. A diff
 * of a .ts file must not be run through a prose renderer.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isReaderMarkdownPath,
  isReaderTexPath,
  renderActivityGroup,
  renderEditDiff,
} from '../src/fleet/activity-render.mjs'
// The chat renderer itself (src/fleet/utils.mjs) cannot be imported here: it
// imports katex's stylesheet, and Node has no loader for .css. So the assertion
// is on ROUTING, which is what the requirement actually is — the card must hand
// its text to the renderer chat uses rather than render text itself — plus the
// shared math normalizer, which is pure and is the thing Skip saw fail.
import { normalizeChatDisplayMathDelimiters } from '../shared/chat-math-normalize.mjs'

const RENDERED = '\u2713rendered\u2713'

/** Stands in for chat's renderMarkdown: same normalizer, and a visible mark so
 *  a test can tell whether a card went through it or printed text itself. */
function markingRenderer(calls) {
  return value => {
    calls.push(value)
    return `${RENDERED}${normalizeChatDisplayMathDelimiters(value)}${RENDERED}`
  }
}

function makeCtx(calls = []) {
  return {
    langFromFilePath: path => (/\.ts$/.test(path) ? 'typescript' : ''),
    highlightSyntax: value => value,
    renderMarkdown: markingRenderer(calls),
    preambleMacros: {},
    calls,
  }
}

const ctx = makeCtx()

const stripAnnotations = html => html.replace(/<annotation[\s\S]*?<\/annotation>/g, '')
const LITERAL_DELIMITERS = /\\\(|\\\)|\\\[|\\\]/

test('a markdown edit diff goes through the chat renderer', () => {
  const calls = []
  const html = renderEditDiff({
    file_path: 'notes/intro.md',
    old_string: 'Inline \\(a + b\\) and display \\[c = d\\].',
    new_string: 'Inline \\(a + z\\) and display \\[c = e\\].',
  }, makeCtx(calls))

  assert.equal(calls.length, 2, 'both sides of the diff went through it')
  assert.match(html, new RegExp(RENDERED), 'its output is what the card shows')
  // The delimiters Skip saw survive as literals: normalized to chat's own.
  assert.doesNotMatch(html, LITERAL_DELIMITERS)
  assert.match(html, /\$a \+ b\$/, 'inline math became chat inline math')
  assert.match(html, /\$\$c = d\$\$/, 'display math became chat display math')
})

test('a code edit diff never reaches the prose renderer', () => {
  const calls = []
  const source = 'const re = /\\(x\\)/ // \\[not math\\]'
  const html = renderEditDiff({
    file_path: 'src/thing.ts',
    old_string: source,
    new_string: source,
  }, makeCtx(calls))

  assert.equal(calls.length, 0, 'code is not prose')
  assert.match(html, /<pre><code>/, 'code renders as code')
  assert.doesNotMatch(html, new RegExp(RENDERED))
})

test('a tex edit diff still renders — the path that was already fixed', () => {
  const html = renderEditDiff({
    file_path: 'paper/main.tex',
    old_string: 'Inline \\(x\\) and display \\[y = x\\].',
    new_string: 'Inline \\(w\\) and display \\[y = w\\].',
  }, ctx)
  assert.match(html, /class="katex/)
  assert.doesNotMatch(stripAnnotations(html), LITERAL_DELIMITERS)
})

// Through the public path a reader actually sees, rather than the private
// function underneath it.
function renderResult(text, calls) {
  const groupCtx = {
    ...makeCtx(calls),
    agentLabel: () => 'agent',
    getNickClass: () => '',
    getAgents: () => [],
  }
  return renderActivityGroup([{
    from: 'fleet:agent',
    timestamp: '2026-08-25T06:00:00.000Z',
    _toolName: 'Bash',
    _toolArg: 'echo hi',
    _toolInput: { command: 'echo hi' },
    _prettyResult: text,
  }], groupCtx)
}

test('a tool result goes through the chat renderer, on escaped text', () => {
  const calls = []
  const rendered = renderResult('Result: \\(n = 3\\)', calls)
  assert.ok(calls.some(value => value.includes('n = 3')), 'the result went through the renderer')
  assert.match(rendered, new RegExp(RENDERED))
  assert.match(rendered, /\$n = 3\$/, 'chat delimiters, not the literal ones')

  // This path alone used to hand RAW tool output to the renderer, while every
  // other call site escaped first.
  const hostileCalls = []
  const hostile = renderResult('<img src=x onerror=alert(1)>', hostileCalls)
  const handed = hostileCalls.find(value => value.includes('img')) || ''
  assert.doesNotMatch(handed, /<img/, 'the renderer is handed escaped text')
  assert.doesNotMatch(hostile, /<img /, 'and no tag reaches the page')
})

test('the reader-text predicates are one decision, and they are narrow', () => {
  for (const path of ['a.md', 'a.MD', 'a.markdown', 'notes/b.qmd', 'c.mdx']) {
    assert.equal(isReaderMarkdownPath(path), true, path)
    assert.equal(isReaderTexPath(path), false, path)
  }
  assert.equal(isReaderTexPath('paper/main.tex'), true)
  for (const path of ['a.ts', 'a.mjs', 'a.py', 'a.json', 'a.txt', 'README', '', null, undefined]) {
    assert.equal(isReaderMarkdownPath(path), false, String(path))
    assert.equal(isReaderTexPath(path), false, String(path))
  }
})
