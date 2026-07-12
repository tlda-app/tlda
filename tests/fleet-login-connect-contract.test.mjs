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

test('fleet agent login replies before fanout side effects', () => {
  const loginStart = serverSource.indexOf("if (type === 'login') {")
  assert.notEqual(loginStart, -1)
  const agentLoginStart = serverSource.indexOf('if (agent_id) {', loginStart)
  assert.notEqual(agentLoginStart, -1)
  const nameLoginStart = serverSource.indexOf('if (!name || typeof name', agentLoginStart)
  assert.notEqual(nameLoginStart, -1)
  const agentLoginBlock = serverSource.slice(agentLoginStart, nameLoginStart)

  const replyAt = agentLoginBlock.indexOf('reply({ ok: true')
  assert.notEqual(replyAt, -1)
  for (const sideEffect of ['fleetStore.share', 'broadcastState()', 'broadcastDaemonAgentsUpdated()']) {
    const sideEffectAt = agentLoginBlock.indexOf(sideEffect)
    assert.notEqual(sideEffectAt, -1)
    assert.ok(replyAt < sideEffectAt, `${sideEffect} must not run before the login reply`)
  }
})

test('fleet socket negotiates permessage-deflate while client loads roster by page', () => {
  assert.match(serverSource, /const fleetWss = new WebSocketServer\(\{[\s\S]*perMessageDeflate: \{ threshold: 1024 \}/)
  assert.match(clientSource, /\/api\/agents\?limit=100/)
  assert.match(clientSource, /loadNextAgentsPage/)
  assert.equal(clientSource.includes('fetch(`${FLEET}/api/state`)'), false)
})

test('fleet client buffers reconnect sends and does not bulk-reject pending requests on close', () => {
  assert.match(clientSource, /new WsReconnectBuffer\(\{[\s\S]*isConnected: \(\) => !!_ws && _ws\.readyState === 1/)
  assert.match(clientSource, /_wsReconnectBuffer\.resolveConnected\(\)/)
  assert.match(clientSource, /await _wsReconnectBuffer\.waitForConnection/)

  const closeStart = clientSource.indexOf('_ws.onclose =')
  assert.notEqual(closeStart, -1)
  const closeBlock = clientSource.slice(closeStart, closeStart + 600)
  assert.equal(closeBlock.includes('rejectWsRequests'), false)
  assert.match(closeBlock, /resetWsRequestIdleTimers\(_wsCallbacks\)/)
})

test('daemon RPC close handling has reconnect grace before pending request rejection', () => {
  assert.match(serverSource, /const DAEMON_RPC_RECONNECT_GRACE_MS = Number/)
  assert.match(serverSource, /const pendingRpcFailureTimers = new Map\(\)/)

  const failStart = serverSource.indexOf('function failPendingRpcsForDaemon')
  assert.notEqual(failStart, -1)
  const failBlock = serverSource.slice(failStart, failStart + 1_200)
  assert.match(failBlock, /setTimeout\(\(\) => \{/)
  assert.match(failBlock, /daemonConnections\.get\(key\)/)
  assert.match(failBlock, /rejectMatchingWsRequests/)

  const notifyStart = serverSource.indexOf('function notifyDaemonReady')
  assert.notEqual(notifyStart, -1)
  const notifyBlock = serverSource.slice(notifyStart, notifyStart + 500)
  assert.match(notifyBlock, /pendingRpcFailureTimers\.get\(daemonKey\)/)
  assert.match(notifyBlock, /clearTimeout\(pendingFailure\)/)
})
