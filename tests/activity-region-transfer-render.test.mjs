import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { mcpEndEvent } from '../agent-runtime/functions-exec-activity.mjs'
import { createActivityExtractor } from '../agent-runtime/jsonl-event-extract.mjs'
import { convertChatEvent } from '../src/fleet/convert-chat-event.mjs'
import { renderActivityGroup } from '../src/fleet/activity-render.mjs'

const { handleFleetTool } = await import('../mcp-server/fleet-tools.mjs')

const CTX = {
  agentLabel: id => id,
  getNickClass: () => '',
  getAgents: () => [],
  getTasks: () => [],
  renderMarkdown: html => html,
  langFromFilePath: () => '',
  highlightSyntax: code => code,
  preambleMacros: {},
}

function renderEvent(metadata) {
  const activity = convertChatEvent({
    id: 1,
    event_type: 'activity',
    from_id: 'fleet:test',
    timestamp: '2026-09-06T08:00:00.000Z',
    metadata,
  })
  return new JSDOM(renderActivityGroup([activity], CTX)).window.document
}

test('real region-transfer dispatch renders through the normal edit diff body', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-region-transfer-card-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'staging.md')
  const target = path.join(dir, 'paper.tex')
  fs.writeFileSync(source, 'before\nnew first\nnew second\nafter\n')
  fs.writeFileSync(target, 'prefix\nold first\nold second\nsuffix\n')
  const input = {
    source_file: source,
    source_start_line: 2,
    source_end_line: 3,
    target_file: target,
    target_start_line: 2,
    target_end_line: 3,
    expected: 'old first\nold second',
  }
  const response = await handleFleetTool('region_transfer', input)
  const nativeEvent = mcpEndEvent({
    call_id: 'region-transfer-1',
    invocation: { server: 'tlda', tool: 'region_transfer', arguments: input },
    result: { Ok: response },
  }, '2026-09-06T08:00:00.000Z')
  const [metadata] = createActivityExtractor().extractActivityEvents([nativeEvent])
  const document = renderEvent(metadata)

  assert.equal(document.querySelector('.tool-name')?.textContent, 'tlda/region_transfer')
  assert.ok(document.querySelector('.tool-line.has-diff'))
  assert.ok(document.querySelector('.edit-diff-wrap .diff-old'))
  assert.ok(document.querySelector('.edit-diff-wrap .diff-new'))
  assert.match(document.querySelector('.diff-old')?.textContent || '', /old first/)
  assert.match(document.querySelector('.diff-new')?.textContent || '', /new first/)
  assert.equal(document.querySelector('.pretty-result'), null)
})

test('normal edit stays a diff and an unrelated tool stays generic', () => {
  const edit = renderEvent({
    tool: 'Edit',
    input: { file_path: 'paper.tex', old_string: 'old', new_string: 'new' },
  })
  assert.ok(edit.querySelector('.tool-line.has-diff'))
  assert.ok(edit.querySelector('.edit-diff-wrap'))

  const generic = renderEvent({ tool: 'tlda/label', input: { agent: 'worker', name: 'reader' } })
  assert.equal(generic.querySelector('.tool-line.has-diff'), null)
  assert.equal(generic.querySelector('.edit-diff-wrap'), null)
})
