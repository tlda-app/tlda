import assert from 'node:assert/strict'
import test from 'node:test'
import { renderActivityGroup } from '../src/fleet/activity-render.mjs'
import { parseCodexLine } from '../bin/lib/codex-activity.mjs'
import { gooseMessageEvents } from '../bin/lib/goose-activity.mjs'

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
