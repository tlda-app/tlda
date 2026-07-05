process.env.FLEET_ID = process.env.FLEET_ID || 'fleet:test-inbox-mode'

import assert from 'node:assert/strict'
import test from 'node:test'

import { getFleetTools, handleFleetTool } from '../mcp-server/fleet-tools.mjs'

test('set_inbox_mode is exposed as the explicit mode-control tool', () => {
  const tool = getFleetTools().find(t => t.name === 'set_inbox_mode')
  assert.ok(tool)
  assert.match(tool.description, /without reading or marking inbox items/)
  assert.deepEqual(tool.inputSchema.required, ['mode'])
  assert.deepEqual(tool.inputSchema.properties.mode.enum, ['focus', 'inbox', 'monitoring', 'incident', 'available', 'review'])
})

test('set_inbox_mode rejects invalid modes before publishing', async () => {
  const res = await handleFleetTool('set_inbox_mode', { mode: 'vacation' })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /Bad inbox mode: vacation/)
  assert.match(res.content[0].text, /focus, inbox, monitoring, incident, available, review/)
})
