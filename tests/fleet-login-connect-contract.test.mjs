import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const serverSource = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
const clientSource = fs.readFileSync(new URL('../src/fleet/fleet-data.mjs', import.meta.url), 'utf8')

test('fleet socket connect has no roster or task init frame ahead of login replies', () => {
  const connectStart = serverSource.indexOf("if (url.pathname === '/ws/fleet')")
  assert.notEqual(connectStart, -1)
  const connectBlock = serverSource.slice(connectStart, connectStart + 2_500)
  assert.equal(connectBlock.includes('initState'), false)
  assert.equal(connectBlock.includes('getAllAgents()'), false)
  assert.equal(connectBlock.includes('getActiveTasks()'), false)
  assert.match(connectBlock, /ws\.on\('message', \(raw\) =>/)
})

test('fleet socket negotiates permessage-deflate while client loads roster by page', () => {
  assert.match(serverSource, /const fleetWss = new WebSocketServer\(\{[\s\S]*perMessageDeflate: \{ threshold: 1024 \}/)
  assert.match(clientSource, /\/api\/agents\?limit=100/)
  assert.match(clientSource, /loadNextAgentsPage/)
  assert.equal(clientSource.includes('fetch(`${FLEET}/api/state`)'), false)
})
