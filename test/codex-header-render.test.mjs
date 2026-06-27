// test/codex-header-render.test.mjs
//
// Deterministic Node.js repro for: "# headers from non-Claude (Codex/Goose)
// agents render as plain text in fleet chat, while Claude's render as <h1>."
//
// Root cause (mode d): renderMarkdown in src/fleet/utils.mjs checks
//   if (typeof window !== 'undefined' && window.marked)
// and falls back to esc(text).replace(/\n/g,'<br>') when window.marked is
// absent.  Codex/Goose narration text arrives as _text activity events and
// goes through this function — in Node.js / SSR / CDN-failure the fallback
// fires, turning "# Header" into literal "# Header" (no <h1>).
//
// This test:
//   1. Proves the ingestion pipeline is clean — parseCodexLine preserves
//      "# Header\n" verbatim (no 4-space indent, no &#35; entity, no missing
//      space after #), ruling out modes a/b/c.
//   2. Confirms mode (d) fires when window.marked is absent: renderActivityGroup
//      with the esc-fallback renderMarkdown produces "# Header" as plain text.
//   3. Confirms that wiring npm marked (the fix applied in utils.mjs) renders
//      the same text as <h1>.

import assert from 'node:assert/strict'
import test from 'node:test'

import { parseCodexLine } from '../bin/lib/codex-activity.mjs'
import { renderActivityGroup, esc } from '../src/fleet/activity-render.mjs'
import { marked } from 'marked'

// ── Ingestion helpers ─────────────────────────────────────────────────────────

// Build a faithful Codex JSONL line whose assistant output_text contains `text`,
// run it through parseCodexLine (the real ingestion code), and return the
// extracted text block value — what actually lands in `arg` for a _text event.
function ingestCodexText(text) {
  const line = JSON.stringify({
    timestamp: '2026-06-26T00:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  })
  const parsed = parseCodexLine(line)
  assert.ok(parsed, 'parseCodexLine returned null — unexpected skip')
  assert.equal(parsed.type, 'assistant')
  const block = parsed.blocks[0]
  assert.equal(block.type, 'text')
  return block.text
}

// Build the activity-message shape that fleet-data.mjs emits from a DB row for
// a _text activity event.  This is exactly what renderActivityGroup receives.
function makeTextActivityMsg(rawText) {
  return {
    from: 'fleet:codex-agent',
    timestamp: '2026-06-26T00:00:00.000Z',
    _activity: true,
    _isText: true,
    _text: rawText,
    _toolName: null,
    _toolArg: '',
    _toolInput: null,
    _prettyResult: null,
    _dbId: 42,
  }
}

// ── renderMarkdown implementations ───────────────────────────────────────────

// Mirrors the PRODUCTION FALLBACK in utils.mjs lines 373-384 when window.marked
// is absent: esc(text).replace(/\n/g, '<br>').  This is what fires in Node.js
// before the fix.
function renderMarkdownEscFallback(html) {
  // un-escape (as utils.mjs does) then re-escape for safe HTML output
  const text = html
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  return esc(text).replace(/\n/g, '<br>')
}

// Mirrors the FIXED path: use npm marked (same as window.marked from CDN).
// This is what utils.mjs does after the fix (importing marked from npm).
function renderMarkdownWithNpmMarked(html) {
  const text = html
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  const result = marked.parse(text, { breaks: true })
  // Unwrap single <p> — matches utils.mjs behaviour
  const trimmed = result.trim()
  if (trimmed.startsWith('<p>') && trimmed.endsWith('</p>') && trimmed.indexOf('<p>', 1) === -1) {
    return trimmed.slice(3, -4)
  }
  return result
}

function makeCtx(renderMarkdown) {
  return {
    agentLabel: id => id,
    getNickClass: () => 'nick-class',
    getAgents: () => [{ id: 'fleet:codex-agent', friendly_name: 'codex-agent' }],
    renderMarkdown,
    highlightSyntax: s => s,
    langFromFilePath: p => p.split('.').pop() || '',
    foldHeights: { diff: 0, bash: 0, write: 0, md: 0 },
    preambleMacros: {},
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('ingestion: parseCodexLine preserves # header verbatim — no 4-space indent, &#35;, or missing space (rules out modes a/b/c)', () => {
  const inputText = '# Findings from code review\n\nThe implementation looks correct.'
  const ingested = ingestCodexText(inputText)

  // Mode (a): 4-space indent would make marked treat it as a code block
  assert.ok(!ingested.startsWith('    '), 'no 4-space indent introduced (mode a)')
  // Mode (b): no-space would prevent marked from recognising as header
  assert.match(ingested, /^# /, 'space after # is preserved (mode b)')
  // Mode (c): &#35; entity would survive renderMarkdown un-escape and appear
  // as literal # to marked — which does NOT parse it as a heading
  assert.ok(!ingested.includes('&#35;'), 'no &#35; entity introduced (mode c)')
  // Text is byte-for-byte identical
  assert.equal(ingested, inputText, 'full text round-trips unchanged through ingestion')
})

test('mode (d) CONFIRMED: esc-fallback renderMarkdown does not produce <h1> for # header', () => {
  // This reproduces the failure: window.marked absent → esc fallback → plain text.
  const rawText = '# Findings from code review\n\nThe implementation looks correct.'
  const msg = makeTextActivityMsg(rawText)
  const html = renderActivityGroup([msg], makeCtx(renderMarkdownEscFallback))

  assert.ok(!html.includes('<h1>'), 'esc fallback must NOT produce <h1>')
  assert.ok(html.includes('# Findings'), '# header appears as literal plain text')
})

test('fix: npm marked renderMarkdown renders # header as <h1> in the body block', () => {
  // This verifies the fix: wiring npm marked produces <h1> as expected.
  // Note: the card header summary ("activity-last-tool" span) shows the raw
  // first line as a compact label — that is by design and is NOT the bug.
  // The rendered body block is what matters; it must contain <h1>.
  const rawText = '# Findings from code review\n\nThe implementation looks correct.'
  const msg = makeTextActivityMsg(rawText)
  const html = renderActivityGroup([msg], makeCtx(renderMarkdownWithNpmMarked))

  assert.ok(html.includes('<h1>'), 'npm marked produces <h1> in the body block')
  // Confirm the <h1> is in the body (pretty-msg-body), not just anywhere
  assert.ok(html.includes('pretty-msg-body'), 'body block is present')
  const bodyStart = html.indexOf('pretty-msg-body')
  const bodyChunk = html.slice(bodyStart, bodyStart + 200)
  assert.ok(bodyChunk.includes('<h1>'), '<h1> is inside the pretty-msg-body block')
})

test('fix: ## subheader and bold text also render correctly', () => {
  const rawText = '## Summary\n\nBuild **passed** with 3 changes.'
  const msg = makeTextActivityMsg(rawText)
  const html = renderActivityGroup([msg], makeCtx(renderMarkdownWithNpmMarked))

  assert.ok(html.includes('<h2>'), '## renders as <h2>')
  assert.ok(html.includes('<strong>'), '** renders as <strong>')
})
