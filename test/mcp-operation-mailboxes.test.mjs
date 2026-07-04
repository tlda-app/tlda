process.env.FLEET_ID = process.env.FLEET_ID || 'fleet:test-mailbox'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  getFleetTools,
  operationMailboxStartedResult,
  startOperationMailbox,
} from '../mcp-server/fleet-tools.mjs'

const fleetToolsSource = readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
const mcpIndexSource = readFileSync(new URL('../mcp-server/index.mjs', import.meta.url), 'utf8')

test('legacy batch respawn and cluster job MCP tools are not advertised', () => {
  const toolNames = new Set(getFleetTools().map(tool => tool.name))
  for (const name of ['batch_respawn', 'job_register', 'job_check', 'job_log']) {
    assert.equal(toolNames.has(name), false, `${name} should not be listed`)
    assert.doesNotMatch(fleetToolsSource, new RegExp(`name:\\s*['"]${name}['"]`))
    assert.doesNotMatch(fleetToolsSource, new RegExp(`if \\(name === ['"]${name}['"]\\)`))
  }
})

test('operation mailbox start returns an immediate handle', () => {
  const mailbox = startOperationMailbox('delegate', { label: 'spawn+delegate' })
  assert.equal(mailbox.ownerId, process.env.FLEET_ID)
  assert.equal(mailbox.kind, 'delegate')
  assert.match(mailbox.id, /^mailbox:/)

  const result = operationMailboxStartedResult(mailbox, { extra: 'agent: tester' })
  assert.equal(result.isError, undefined)
  assert.match(result.content[0].text, /delegate mailbox mailbox:/)
  assert.match(result.content[0].text, /Completion will arrive as fleet chat/)
  assert.match(result.content[0].text, /agent: tester/)
})

test('screenshot, doc_view, and spawn+delegate use operation mailboxes', () => {
  assert.match(mcpIndexSource, /startOperationMailbox\('screenshot'/)
  assert.match(mcpIndexSource, /startOperationMailbox\('doc_view'/)
  assert.match(mcpIndexSource, /deliverOperationMailboxCompletion\(mailbox, 'completed'/)

  assert.match(fleetToolsSource, /startOperationMailbox\('delegate'/)
  assert.match(fleetToolsSource, /spawn_mailbox_id/)
  assert.match(fleetToolsSource, /findSpawnedDelegateTarget\(agentName, spawnResult, \{ attempts: 300, delayMs: 1000 \}\)/)
  assert.doesNotMatch(fleetToolsSource, /async delegation is not migrated yet/)
})

test('report no longer auto-runs screenshot collection', () => {
  assert.doesNotMatch(fleetToolsSource, /screenshot-dashboard/)
  assert.doesNotMatch(fleetToolsSource, /Auto-screenshot failed/)
  assert.doesNotMatch(fleetToolsSource, /screenshotSection/)
})
