import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const serverSource = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
const clientSource = fs.readFileSync(new URL('../src/fleet/fleet-data.mjs', import.meta.url), 'utf8')
const mcpFleetSource = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')

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
  for (const sideEffect of ['fleetStore.share', 'broadcastState(storedAgent)', 'broadcastDaemonAgentsUpdated']) {
    const sideEffectAt = agentLoginBlock.indexOf(sideEffect)
    assert.notEqual(sideEffectAt, -1)
    assert.ok(replyAt < sideEffectAt, `${sideEffect} must not run before the login reply`)
  }
})

test('fleet agents-delta hot path is targeted and taskless by default', () => {
  const broadcastStart = serverSource.indexOf('function _broadcastStateNow()')
  assert.notEqual(broadcastStart, -1)
  const broadcastEnd = serverSource.indexOf('function mintFleetId()', broadcastStart)
  assert.notEqual(broadcastEnd, -1)
  const broadcastBlock = serverSource.slice(broadcastStart, broadcastEnd)

  assert.match(broadcastBlock, /const pendingIds = \[\.\.\._pendingBroadcastAgentIds\]/)
  assert.equal(broadcastBlock.includes('getAliveAgents()'), false)
  assert.equal(broadcastBlock.includes('getActiveTasks()'), false)
  assert.match(broadcastBlock, /task_delta: fleetStore\.consumeTaskChanges/)
  assert.equal(broadcastBlock.includes('tasks: fleetStore.getActiveTasks()'), false)

  const deltaStart = clientSource.indexOf("if (eventType === 'agents-delta')")
  assert.notEqual(deltaStart, -1)
  const deltaBlock = clientSource.slice(deltaStart, deltaStart + 500)
  assert.match(deltaBlock, /applyTaskDelta\(data\.task_delta\)/)
  assert.equal(deltaBlock.includes('updateTasks(data.tasks || [])'), false)
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

test('fleet MCP sendWS waits through reconnect-buffer chunks until the request deadline', () => {
  const sendStart = mcpFleetSource.indexOf('async function sendWS')
  assert.notEqual(sendStart, -1)
  const sendBlock = mcpFleetSource.slice(sendStart, sendStart + 900)

  assert.match(sendBlock, /deadlineMs = opts\.deadlineMs \?\? opts\.idleTimeoutMs \?\? WS_REQUEST_IDLE_MS/)
  assert.match(sendBlock, /waitForConnection\(Math\.min\(remaining, 5_000\)\)/)
  assert.equal(sendBlock.includes('if (!connected && !_channelRWS?.connected) break;'), false)
  assert.match(sendBlock, /Date\.now\(\) - startedAt >= deadlineMs\) break/)
  assert.match(sendBlock, /fleet WS request was not accepted before deadline/)

  assert.equal(mcpFleetSource.includes('Login failed: fleet WS not connected after 2s.'), false)
})

test('fleet MCP chat result is transport-only, with no HTTP visibility probe', () => {
  const chatStart = mcpFleetSource.indexOf("if (name === 'chat')")
  assert.notEqual(chatStart, -1)
  const terminalStart = mcpFleetSource.indexOf('// ---- request_terminal ----', chatStart)
  assert.notEqual(terminalStart, -1)
  const chatBlock = mcpFleetSource.slice(chatStart, terminalStart)

  assert.equal(chatBlock.includes('/api/health'), false)
  assert.equal(chatBlock.includes('/api/projects'), false)
  assert.equal(chatBlock.includes('tlda is down'), false)
  assert.equal(chatBlock.includes('Skip cannot see'), false)
  assert.equal(chatBlock.includes('server may be down'), false)
  assert.match(chatBlock, /Queued for durable delivery; no server ACK yet/)
})

test('fleet MCP transport errors do not invent backend or visibility probes', () => {
  const forbidden = [
    'tlda backend not answering',
    "backend didn't answer",
    'tell ops if it persists',
    'server may be down',
    'Skip cannot see',
    'tlda is down',
  ]
  for (const phrase of forbidden) {
    assert.equal(mcpFleetSource.includes(phrase), false, `forbidden transport wording: ${phrase}`)
  }
  assert.match(mcpFleetSource, /Fleet transport failed before ACK/)
  assert.match(mcpFleetSource, /failed before transport ACK/)
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

test('pending spawn shell rows are not treated as wakeable hibernating agents', () => {
  const wakeStart = serverSource.indexOf('function requestWake(agentId')
  assert.notEqual(wakeStart, -1)
  const wakeBlock = serverSource.slice(wakeStart, wakeStart + 1_500)

  const shellGuardAt = wakeBlock.indexOf('isReservedShellAgent(agent)')
  const queueAt = wakeBlock.indexOf('_wakeQueue.set')
  assert.notEqual(shellGuardAt, -1)
  assert.notEqual(queueAt, -1)
  assert.ok(shellGuardAt < queueAt, 'reserved shells must be filtered before wake queueing')
  assert.match(wakeBlock, /status: 'pending-shell'/)
  assert.match(wakeBlock, /state: 'spawning'/)
})

test('spawn mailbox completion does not collapse login into usability', () => {
  const completionStart = serverSource.indexOf('function spawnMailboxCompletionText')
  assert.notEqual(completionStart, -1)
  const completionBlock = serverSource.slice(completionStart, completionStart + 900)

  assert.equal(completionBlock.includes('logged in and usable'), false)
  assert.match(completionBlock, /has logged in and is ready for inbox pickup/)
})
