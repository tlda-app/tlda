// Guard: the delegate spawn path enforces one name. A spawned agent's only name
// is `spawn.name`; passing a divergent `friendly_name` is the desync that
// produced ghost rows (a never-seen "math-historian" stub beside the live
// "math historian"). The guard must reject it BEFORE any spawn/network call.
//
// FLEET_ID is set before importing fleet-tools so AGENT_ID is truthy (the
// handler short-circuits unregistered callers ahead of the guard). The guard
// returns before sendWS, so no server/WS is needed.

process.env.FLEET_ID = process.env.FLEET_ID || 'fleet:test-onename'

import assert from 'node:assert/strict'
import test from 'node:test'

import { handleFleetTool } from '../mcp-server/fleet-tools.mjs'

test('delegate rejects friendly_name on the spawn path (one name, enforced)', async () => {
  const res = await handleFleetTool('delegate', {
    spawn: { name: 'math-historian' },
    friendly_name: 'math historian (fence/capability/guidance)',
    message: 'do a thing',
  })
  assert.equal(res.isError, true, 'spawn + divergent friendly_name must be rejected')
  assert.match(res.content[0].text, /friendly_name/)
  assert.match(res.content[0].text, /spawn\.name/)
})

test('delegate rejects friendly_name even when it equals spawn.name (no desync option)', async () => {
  const res = await handleFleetTool('delegate', {
    spawn: { name: 'math-historian' },
    friendly_name: 'math-historian',
    message: 'do a thing',
  })
  assert.equal(res.isError, true, 'friendly_name is not a valid spawn-path arg at all')
})
