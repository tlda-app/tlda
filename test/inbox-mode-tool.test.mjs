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

test('fleet_table renders visible inbox modes', async () => {
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      totals: { awake: 1, hibernating: 0, dead: 0, total: 1 },
      matched: 1,
      shown: 1,
      summary: { inbox_modes: [{ value: 'focus', count: 1 }] },
      agents: [{
        name: 'mode-agent',
        status: 'awake',
        last_seen_ago_s: 10,
        inbox_mode: 'focus',
        model: 'gpt-test',
        activity: null,
        tool: null,
        cwd: '/tmp/project',
      }],
    }),
  })
  try {
    const res = await handleFleetTool('fleet_table', {})
    assert.equal(res.isError, undefined)
    assert.match(res.content[0].text, /Inbox modes: focus/)
    assert.match(res.content[0].text, /agent\s+status\s+seen\s+mode\s+model\s+activity\s+cwd/)
    assert.match(res.content[0].text, /mode-agent\s+awake\s+10s\s+focus\s+gpt-test/)
  } finally {
    globalThis.fetch = prevFetch
  }
})
