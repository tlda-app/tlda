import assert from 'node:assert/strict'
import test from 'node:test'
import { renderActivityGroup } from '../src/fleet/activity-render.mjs'
import { parseCodexLine } from '../bin/lib/codex-activity.mjs'
import { gooseMessageEvents } from '../bin/lib/goose-activity.mjs'
import { formatActivity } from '../mcp-server/format-annotation.mjs'
import { normalizePrettyResult, unwrapMcpTextEnvelope } from '../shared/activity-pretty-result.mjs'

const ctx = {
  agentLabel: id => id,
  getNickClass: () => 'nick-agent-0',
  getAgents: () => [{ id: 'agent-1', friendly_name: 'agent-1' }],
  renderMarkdown: s => s,
  highlightSyntax: s => s,
  langFromFilePath: p => p.split('.').pop() || '',
  foldHeights: { diff: 0 },
  preambleMacros: {},
}

test('Codex-style Edit activity with unified diff renders side-by-side diff card', () => {
  const html = renderActivityGroup([{
    from: 'agent-1',
    timestamp: '2026-06-17T00:00:00.000Z',
    _activity: true,
    _toolName: 'Edit',
    _toolArg: '/tmp/example.js',
    _toolInput: {
      file_path: '/tmp/example.js',
      op: 'update',
      diff: '@@\n-const x = 1\n+const x = 2',
    },
  }], ctx)

  assert.match(html, /edit-unified-side-by-side-wrap/)
  assert.match(html, /example\.js/)
  assert.match(html, /diff-old/)
  assert.match(html, /diff-new/)
  assert.doesNotMatch(html, /edit-unified-diff-wrap/)
  assert.match(html, /const x = 1/)
  assert.match(html, /const x = 2/)
})

test('Codex apply_patch parser output renders as useful diff card', () => {
  const patch = `*** Begin Patch
*** Update File: /tmp/example.js
@@
-const x = 1
+const x = 2
*** End Patch`
  const ev = parseCodexLine(JSON.stringify({
    type: 'response_item',
    timestamp: '2026-06-17T00:00:00.000Z',
    payload: {
      type: 'custom_tool_call',
      name: 'apply_patch',
      call_id: 'codex-patch-1',
      input: patch,
    },
  }))
  const block = ev.blocks[0]
  const html = renderActivityGroup([{
    from: 'agent-1',
    timestamp: ev.timestamp,
    _activity: true,
    _toolName: block.name,
    _toolArg: block.input.file_path,
    _toolInput: block.input,
  }], ctx)

  assert.equal(block.name, 'Edit')
  assert.equal(block.input.file_path, '/tmp/example.js')
  assert.match(block.input.diff, /const x = 2/)
  assert.match(html, /tool-name">Edit/)
  assert.match(html, /edit-unified-side-by-side-wrap/)
  assert.match(html, /example\.js/)
  assert.match(html, /diff-old/)
  assert.match(html, /diff-new/)
  assert.match(html, /const x = 1/)
  assert.match(html, /const x = 2/)
})

test('Goose apply_patch tool request normalizes to Edit events with diff', () => {
  const patch = `*** Begin Patch
*** Update File: /tmp/example.js
@@
-const x = 1
+const x = 2
*** End Patch`
  const events = gooseMessageEvents({
    role: 'assistant',
    created_timestamp: 1770000000,
    content_json: JSON.stringify([{
      id: 'goose-patch-1',
      type: 'toolRequest',
      toolCall: { value: { name: 'apply_patch', arguments: { input: patch } } },
    }]),
  })

  assert.equal(events.length, 1)
  assert.equal(events[0].tool, 'Edit')
  assert.equal(events[0].arg, '/tmp/example.js')
  assert.equal(events[0].input.file_path, '/tmp/example.js')
  assert.match(events[0].input.diff, /const x = 2/)
})

test('Goose same-row get_thread response attaches pretty result to the tool event', () => {
  const prettyText = `2 messages (6/18/2026, 8:00:00 AM -> 8:01:00 AM)

[6/18/2026, 8:00:00 AM] skip → agent-1
first message`
  const events = gooseMessageEvents({
    role: 'assistant',
    created_timestamp: 1770000000,
    content_json: JSON.stringify([
      {
        id: 'goose-thread-1',
        type: 'toolRequest',
        toolCall: { value: { name: 'tlda__get_thread', arguments: { agent: 'agent-1' } } },
      },
      {
        id: 'goose-thread-1',
        type: 'toolResponse',
        toolResult: {
          value: `Wall time: 0.123 seconds\nOutput:\n${JSON.stringify([{ type: 'text', text: prettyText }])}`,
        },
      },
    ]),
  })

  assert.equal(events.length, 1)
  assert.equal(events[0].tool, 'tlda/get_thread')
  assert.equal(events[0].arg, '')
  assert.match(events[0].prettyResult, /2 messages/)
  assert.match(events[0].prettyResult, /first message/)
  assert.doesNotMatch(events[0].prettyResult, /\[\{"type":"text"/)
  assert.doesNotMatch(events[0].prettyResult, /Wall time:/)
  assert.equal(events[0].origTool, undefined)
})

test('Goose split-row pretty result preserves original tool request timestamp', () => {
  const requestEvents = gooseMessageEvents({
    role: 'assistant',
    created_timestamp: 1770000048,
    content_json: JSON.stringify([{
      id: 'goose-search-1',
      type: 'toolRequest',
      toolCall: { value: { name: 'tlda__search_logs', arguments: { query: 'activity parity' } } },
    }]),
  })

  assert.equal(requestEvents.length, 1)
  assert.equal(requestEvents[0].tool, 'tlda/search_logs')

  const responseEvents = gooseMessageEvents({
    role: 'user',
    created_timestamp: 1770000039,
    content_json: JSON.stringify([{
      id: 'goose-search-1',
      type: 'toolResponse',
      toolResult: {
        value: { content: [{ type: 'text', text: 'No results for "activity parity".' }] },
      },
    }]),
  })

  assert.equal(responseEvents.length, 1)
  assert.equal(responseEvents[0].tool, '_prettyResult')
  assert.equal(responseEvents[0].origTool, 'tlda/search_logs')
  assert.equal(responseEvents[0].prettyResult, 'No results for "activity parity".')
  assert.equal(responseEvents[0].ts, requestEvents[0].ts)
})

test('shared pretty-result unwrap handles Codex and MCP envelopes', () => {
  const wrapped = 'Wall time: 0.123 seconds\nOutput:\n[{"type":"text","text":"first"},{"type":"text","text":"second"}]'
  assert.equal(unwrapMcpTextEnvelope(wrapped), 'first\nsecond')
})

test('shared pretty-result normalizer handles Claude, Codex, and Goose envelopes', () => {
  const claude = [{ type: 'text', text: 'claude text' }]
  const codex = 'Wall time: 0.123 seconds\nOutput:\n[{"type":"text","text":"codex text"}]'
  const goose = { content: [{ type: 'text', text: 'goose text' }] }

  assert.equal(normalizePrettyResult(claude), 'claude text')
  assert.equal(normalizePrettyResult(codex), 'codex text')
  assert.equal(normalizePrettyResult(goose), 'goose text')
})

test('annotation activity formatter unwraps pretty result envelopes', () => {
  const text = 'thread line one\nthread line two'
  const formatted = formatActivity([{
    from: 'fleet:agent-1',
    timestamp: '2026-06-18T12:00:00.000Z',
    text: 'tlda/get_thread',
    metadata: {
      tool: 'tlda/get_thread',
      prettyResult: JSON.stringify([{ type: 'text', text }]),
    },
  }], [{ id: 'fleet:agent-1', friendly_name: 'agent-1' }])

  assert.match(formatted, /thread line one/)
  assert.match(formatted, /thread line two/)
  assert.doesNotMatch(formatted, /\[\{"type":"text"/)
})

test('annotation activity formatter strips Codex wall-time output wrappers', () => {
  const wrapped = 'Wall time: 0.123 seconds\nOutput:\n[{"type":"text","text":"thread line one\\nthread line two"}]'
  const formatted = formatActivity([{
    from: 'fleet:agent-1',
    timestamp: '2026-06-18T12:00:00.000Z',
    text: 'tlda/get_thread',
    metadata: {
      tool: 'tlda/get_thread',
      prettyResult: wrapped,
    },
  }], [{ id: 'fleet:agent-1', friendly_name: 'agent-1' }])

  assert.match(formatted, /thread line one/)
  assert.match(formatted, /thread line two/)
  assert.doesNotMatch(formatted, /Wall time:/)
  assert.doesNotMatch(formatted, /Output:/)
  assert.doesNotMatch(formatted, /\[\{"type":"text"/)
})

test('get_thread pretty result strips summary header before parsing first row', () => {
  const html = renderActivityGroup([{
    from: 'agent-1',
    timestamp: '2026-06-17T00:00:00.000Z',
    _activity: true,
    _toolName: 'mcp__tlda__get_thread',
    _toolArg: 'agent-1',
    _prettyResult: `2 messages (6/17/2026, 6:00:00 AM -> 6:01:00 AM)

[6/17/2026, 6:00:00 AM] skip → agent-1
first message

---

[6/17/2026, 6:01:00 AM] agent-1 → skip
second message`,
  }], ctx)

  assert.match(html, /pretty-result-header/)
  assert.match(html, /2 messages/)
  assert.match(html, /data-msg-from="skip"/)
  assert.match(html, /first message/)
  assert.doesNotMatch(html, /2 messages[\s\S]*first message[\s\S]*2 messages/)
})

test('get_thread pretty result unwraps MCP text envelope before rendering', () => {
  const prettyText = `2 messages (6/18/2026, 8:00:00 AM -> 8:01:00 AM)

[6/18/2026, 8:00:00 AM] skip → agent-1
first message

---

[6/18/2026, 8:01:00 AM] agent-1 → skip
second message`
  const html = renderActivityGroup([{
    from: 'agent-1',
    timestamp: '2026-06-18T12:00:00.000Z',
    _activity: true,
    _toolName: 'mcp__tlda__get_thread',
    _toolArg: 'agent-1',
    _prettyResult: JSON.stringify([{ type: 'text', text: prettyText }]),
  }], ctx)

  assert.match(html, /tool-pretty-thread/)
  assert.match(html, /pretty-result-header/)
  assert.match(html, /2 messages/)
  assert.match(html, /data-msg-from="skip"/)
  assert.match(html, /first message/)
  assert.match(html, /second message/)
  assert.doesNotMatch(html, /\[\{&quot;type&quot;:&quot;text&quot;/)
  assert.doesNotMatch(html, /\\n\\n/)
})

test('get_thread pretty result handles provenance header and spaced agent tags', () => {
  const prettyText = `4 messages (6/18/2026, 5:40:48 AM → 6/18/2026, 5:41:02 AM)
↳ agent-7lpi → get-thread-render-fix · fleet:d5aa87a8

[6/18/2026, 5:40:48 AM] agent-7lpi fleet:d5aa87a8 →now:get-thread-render-fix → agent-7lpi fleet:d5aa87a8 →now:get-thread-render-fix
agent-7lpi registered

---

[6/18/2026, 5:40:50 AM] todo-rollout-manager fleet:65412ad1 → agent-7lpi fleet:d5aa87a8 →now:get-thread-render-fix
[DELEGATE]
Fix get_thread rendering`
  const html = renderActivityGroup([{
    from: 'agent-1',
    timestamp: '2026-06-18T12:00:00.000Z',
    _activity: true,
    _toolName: 'mcp__tlda__get_thread',
    _toolArg: 'get-thread-render-fix',
    _prettyResult: JSON.stringify([{ type: 'text', text: prettyText }]),
  }], ctx)

  assert.match(html, /tool-pretty-thread/)
  assert.match(html, /pretty-result-header/)
  assert.match(html, /agent-7lpi → get-thread-render-fix/)
  assert.match(html, /data-msg-from="agent-7lpi fleet:d5aa87a8 →now:get-thread-render-fix"/)
  assert.match(html, /data-msg-from="todo-rollout-manager fleet:65412ad1"/)
  assert.match(html, /Fix get_thread rendering/)
  assert.doesNotMatch(html, /<div class="pretty-msg-body">4 messages/)
})

test('get_thread pretty result strips Codex wall-time output wrapper before rendering', () => {
  const prettyText = `2 messages (6/18/2026, 8:00:00 AM -> 8:01:00 AM)

[6/18/2026, 8:00:00 AM] skip → agent-1
first message

---

[6/18/2026, 8:01:00 AM] agent-1 → skip
second message`
  const html = renderActivityGroup([{
    from: 'agent-1',
    timestamp: '2026-06-18T12:00:00.000Z',
    _activity: true,
    _toolName: 'mcp__tlda__get_thread',
    _toolArg: 'agent-1',
    _prettyResult: `Wall time: 0.123 seconds\nOutput:\n${JSON.stringify([{ type: 'text', text: prettyText }])}`,
  }], ctx)

  assert.match(html, /tool-pretty-thread/)
  assert.match(html, /pretty-result-header/)
  assert.match(html, /data-msg-from="skip"/)
  assert.match(html, /first message/)
  assert.match(html, /second message/)
  assert.doesNotMatch(html, /Wall time:/)
  assert.doesNotMatch(html, /Output:/)
  assert.doesNotMatch(html, /\[\{&quot;type&quot;:&quot;text&quot;/)
  assert.doesNotMatch(html, /\\n\\n/)
})

test('search pretty result strips Codex wall-time output wrapper before rendering', () => {
  const prettyText = `2 results (1 fleet, 1 session)

6/18/2026, 8:00:00 AM | [fleet] [activity] agent-1 | **match** one

6/18/2026, 8:01:00 AM | [session] [assistant] agent-1 | **match** two`
  const html = renderActivityGroup([{
    from: 'agent-1',
    timestamp: '2026-06-18T12:00:00.000Z',
    _activity: true,
    _toolName: 'mcp__tlda__search_logs',
    _toolArg: 'match',
    _prettyResult: `Wall time: 0.123 seconds\nOutput:\n${JSON.stringify([{ type: 'text', text: prettyText }])}`,
  }], ctx)

  assert.match(html, /tool-pretty-search/)
  assert.match(html, /2 results/)
  assert.match(html, /<mark>match<\/mark> one/)
  assert.match(html, /<mark>match<\/mark> two/)
  assert.doesNotMatch(html, /Wall time:/)
  assert.doesNotMatch(html, /Output:/)
  assert.doesNotMatch(html, /\[\{&quot;type&quot;:&quot;text&quot;/)
})
