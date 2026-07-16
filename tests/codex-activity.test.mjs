import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseCodexLine,
  unwrapCodexToolOutput,
} from '../agent-runtime/codex-activity.mjs'
import {
  createActivityExtractor,
  parseSessionLine,
} from '../agent-runtime/jsonl-event-extract.mjs'
import { renderActivityGroup } from '../src/fleet/activity-render.mjs'

function codexOutputLine(output, type = 'function_call_output', callId = 'call-test') {
  return JSON.stringify({
    type: 'response_item',
    timestamp: '2026-06-17T00:00:00.000Z',
    payload: { type, call_id: callId, output },
  })
}

function extractCards(events) {
  const extractor = createActivityExtractor()
  return extractor.extractActivityEvents(events)
}

const renderCtx = {
  agentLabel: id => id,
  getNickClass: () => 'chat-nick',
  getAgents: () => [],
  renderMarkdown: html => html,
  highlightSyntax: code => code,
  langFromFilePath: () => '',
  preambleMacros: {},
  foldHeights: {},
}

function renderActivity(activity) {
  return renderActivityGroup([{
    from: 'fleet:test',
    agent: 'fleet:test',
    timestamp: activity.ts || '2026-06-17T00:00:00.000Z',
    _activity: true,
    _toolName: activity.tool,
    _toolArg: activity.arg,
    _toolInput: activity.input || null,
    _toolDetail: null,
    _prettyResult: activity.prettyResult || null,
    _dbId: 1,
  }], renderCtx)
}

test('tool result strips Codex output envelopes', () => {
  const ev = parseCodexLine(codexOutputLine('Wall time: 0.123 seconds\nOutput:\nhello\n'))
  assert.equal(ev.blocks[0].text, 'hello\n')

  const wrapped = 'Wall time: 0.123 seconds\nOutput:\n[{"type":"text","text":"first"},{"type":"text","text":"second"}]'
  const custom = parseCodexLine(codexOutputLine(wrapped, 'custom_tool_call_output'))
  assert.equal(custom.blocks[0].text, 'first\nsecond')

  const image = 'Wall time: 0.123 seconds\nOutput:\n[{"type":"image","data":"x"}]'
  assert.equal(unwrapCodexToolOutput(image), '[{"type":"image","data":"x"}]')
})

test('Codex pretty-print requests wait for result and keep original tool shape', () => {
  const request = parseCodexLine(JSON.stringify({
    type: 'response_item',
    timestamp: '2026-06-17T00:00:00.000Z',
    payload: {
      type: 'function_call',
      name: 'get_thread',
      namespace: 'mcp__tlda',
      arguments: JSON.stringify({ agent: 'bhist' }),
      call_id: 'call-thread-delayed',
    },
  }))

  const extractor = createActivityExtractor()
  assert.deepEqual(extractor.extractActivityEvents([request]), [])

  const result = parseCodexLine(codexOutputLine(
    'Wall time: 0.123 seconds\nOutput:\n[{"type":"text","text":"1 message\\n\\n[6/18/2026, 8:00:00 AM] skip → bhist\\nhello"}]',
    'function_call_output',
    'call-thread-delayed',
  ))
  const cards = extractor.extractActivityEvents([result])
  const delayedCard = cards.find(c => c.tool === 'tlda/get_thread')

  assert.match(delayedCard?.prettyResult || '', /skip → bhist/)
  assert.equal(cards.some(c => c.tool === '_prettyResult'), false)
})

test('Codex tool_search_call renders generically with query arg', () => {
  const ev = parseCodexLine(JSON.stringify({
    type: 'response_item',
    timestamp: '2026-06-17T00:00:00.000Z',
    payload: {
      type: 'tool_search_call',
      call_id: 'call-tool-search',
      arguments: { query: 'tlda fleet MCP', limit: 5 },
    },
  }))
  const [card] = extractCards([ev])
  assert.equal(card.tool, 'tool_search')
  assert.equal(card.arg, 'tlda fleet MCP')
})

test('non-tlda namespaced MCP/app tool renders with compact generic args', () => {
  const ev = parseCodexLine(JSON.stringify({
    type: 'response_item',
    timestamp: '2026-06-17T00:00:00.000Z',
    payload: {
      type: 'function_call',
      name: 'hotline.get_local_hotline',
      namespace: 'mcp__codex_apps__hotline',
      arguments: JSON.stringify({ country: 'US' }),
      call_id: 'call-hotline',
    },
  }))
  const [card] = extractCards([ev])
  assert.equal(card.tool, 'codex_apps/hotline/hotline.get_local_hotline')
  assert.equal(card.arg, 'country=US')
})

test('unknown future Codex function_call renders generically instead of dropping', () => {
  const ev = parseCodexLine(JSON.stringify({
    type: 'response_item',
    timestamp: '2026-06-17T00:00:00.000Z',
    payload: {
      type: 'function_call',
      name: 'future_release_tool',
      arguments: JSON.stringify({ target: 'chat', mode: 'new' }),
      call_id: 'call-future',
    },
  }))
  const [card] = extractCards([ev])
  assert.equal(card.tool, 'future_release_tool')
  assert.match(card.arg, /target=chat/)

  const html = renderActivity(card)
  assert.match(html, /class="tool-name">future_release_tool</)
  assert.match(html, /class="tool-arg">target=chat/)
})

test('observed Codex tool classes produce non-empty activity cards', () => {
  const observed = [
    ['apply_patch', { input: '*** Begin Patch\n*** Update File: x\n@@\n-a\n+b\n*** End Patch' }],
    ['collaboration__followup_task', { description: 'next' }],
    ['collaboration__interrupt_agent', { agent: 'a1' }],
    ['collaboration__list_agents', { query: 'awake' }],
    ['collaboration__send_message', { target: 'a1', message: 'hi' }],
    ['collaboration__spawn_agent', { description: 'helper' }],
    ['collaboration__wait_agent', { agent: 'a1' }],
    ['exec', { cmd: 'date' }],
    ['exec_command', { cmd: 'ls -la' }],
    ['mcp__codex__list_mcp_resources', { server: 'codex' }],
    ['multi_agent_v1__send_input', { target: 'a1', message: 'go' }],
    ['multi_agent_v1__spawn_agent', { message: 'help' }],
    ['multi_agent_v1__wait_agent', { target: 'a1' }],
    ['tool_search', { query: 'chat tool' }],
    ['update_plan', { plan: [{ step: 'one', status: 'pending' }] }],
    ['view_image', { path: '/tmp/x.png' }],
    ['wait', { duration: 1 }],
    ['write_stdin', { session_id: 7, chars: 'q' }],
  ]

  for (const [name, args] of observed) {
    const ev = parseCodexLine(JSON.stringify({
      type: 'response_item',
      timestamp: '2026-06-17T00:00:00.000Z',
      payload: {
        type: name === 'apply_patch' ? 'custom_tool_call' : 'function_call',
        name,
        arguments: JSON.stringify(args),
        input: args.input,
        call_id: `call-${name}`,
      },
    }))
    const cards = extractCards([ev]).filter(c => c.tool !== '_usage' && c.tool !== '_text')
    assert.ok(cards.length > 0, `${name} produced no card`)
    assert.ok(cards.every(c => c.tool && c.arg !== undefined), `${name} produced an empty card`)
  }
})

test('Claude unknown tool_use parses to generic activity and actual render HTML', () => {
  const ev = parseSessionLine(JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-17T00:00:00.000Z',
    message: {
      content: [{
        type: 'tool_use',
        id: 'toolu-future',
        name: 'FutureClaudeTool',
        input: { query: 'paper annotations', limit: 3 },
      }],
    },
  }))
  const [card] = extractCards([ev])
  assert.equal(card.tool, 'FutureClaudeTool')
  assert.equal(card.arg, 'paper annotations')

  const html = renderActivity(card)
  assert.match(html, /class="tool-name">FutureClaudeTool</)
  assert.match(html, /class="tool-arg">paper annotations</)
  assert.match(html, /tool-run-card/)
})
