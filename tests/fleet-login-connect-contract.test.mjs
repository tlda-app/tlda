import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const serverSource = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
const fleetRoutesSource = fs.readFileSync(new URL('../server/routes/fleet.mjs', import.meta.url), 'utf8')
const fleetStoreSource = fs.readFileSync(new URL('../server/lib/fleet-store.mjs', import.meta.url), 'utf8')
const clientSource = fs.readFileSync(new URL('../src/fleet/fleet-data.mjs', import.meta.url), 'utf8')
const mcpFleetSource = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
const terminalShapeSource = fs.readFileSync(new URL('../src/shapes/TerminalShape.tsx', import.meta.url), 'utf8')
const daemonSource = fs.readFileSync(new URL('../bin/fleet-daemon.mjs', import.meta.url), 'utf8')

test('fleet socket connect has no roster or task init frame ahead of login replies', () => {
  const connectStart = serverSource.indexOf("if (url.pathname === '/ws/fleet')")
  assert.notEqual(connectStart, -1)
  const connectBlock = serverSource.slice(connectStart, connectStart + 2_500)
  assert.equal(connectBlock.includes('initState'), false)
  assert.equal(connectBlock.includes('getAllAgents()'), false)
  assert.equal(connectBlock.includes('getActiveTasks()'), false)
  assert.match(connectBlock, /ws\.on\('message', \(raw\) =>/)
})

test('task doc startup materialization is deferred off module initialization', () => {
  const storeStart = serverSource.indexOf('const fleetStore = new FleetStore')
  assert.notEqual(storeStart, -1)
  const loopMonitorStart = serverSource.indexOf('const HOT_OP_WARN_MS', storeStart)
  assert.notEqual(loopMonitorStart, -1)
  const startupBlock = serverSource.slice(storeStart, loopMonitorStart)

  assert.match(startupBlock, /TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS \?\? -1/)
  assert.match(startupBlock, /function scheduleStartupTaskDocFlush\(\)/)
  assert.match(startupBlock, /if \(TASK_DOC_STARTUP_FLUSH_DELAY_MS < 0\) return/)
  assert.match(startupBlock, /setTimeout\(\(\) => \{/)
  assert.match(startupBlock, /fleetStore\.flushTaskDocs\?\.\(\)/)
  assert.match(startupBlock, /scheduleStartupTaskDocFlush\(\)/)
  assert.equal(startupBlock.includes('\nfleetStore.flushTaskDocs?.()\n'), false)
})

test('startup qualification, task renudge, and runtime status avoid full roster hydration', () => {
  const qualificationStart = serverSource.indexOf('function qualLoadReadsFromDb()')
  assert.notEqual(qualificationStart, -1)
  const qualificationEnd = serverSource.indexOf('let _latexProjectDirs', qualificationStart)
  assert.notEqual(qualificationEnd, -1)
  const qualificationBlock = serverSource.slice(qualificationStart, qualificationEnd)
  assert.equal(qualificationBlock.includes('getAllAgents()'), false)
  assert.match(qualificationBlock, /getAllSkillReadsByAgent/)

  const renudgeStart = serverSource.indexOf('function runTaskRenudgeSweep()')
  assert.notEqual(renudgeStart, -1)
  const renudgeEnd = serverSource.indexOf('if (TASK_RENUDGE_SWEEP_MS > 0)', renudgeStart)
  assert.notEqual(renudgeEnd, -1)
  const renudgeBlock = serverSource.slice(renudgeStart, renudgeEnd)
  assert.equal(renudgeBlock.includes('getAllAgents()'), false)
  assert.match(renudgeBlock, /getAgentsByIds/)

  const runtimeStart = serverSource.indexOf("app.get('/api/runtime-status'")
  assert.notEqual(runtimeStart, -1)
  const runtimeEnd = serverSource.indexOf('// ---------- Education enforcement ----------', runtimeStart)
  assert.notEqual(runtimeEnd, -1)
  const runtimeBlock = serverSource.slice(runtimeStart, runtimeEnd)
  assert.equal(runtimeBlock.includes('getAllAgents()'), false)
  assert.match(runtimeBlock, /getAgentSummary/)
})

test('session entry search backfill is delayed and avoids all-session startup scan', () => {
  assert.equal(fleetStoreSource.includes('SELECT DISTINCT session_id FROM session_entries'), false)
  assert.match(fleetStoreSource, /SELECT 1 FROM session_entries WHERE session_id = \? LIMIT 1/)
  assert.match(serverSource, /TLDA_SESSION_BACKFILL_STARTUP_DELAY_MS \|\| 60_000/)

  const scheduleStart = serverSource.indexOf('function scheduleSessionEntryBackfill()')
  assert.notEqual(scheduleStart, -1)
  const ownerStart = serverSource.indexOf('// Ensure server owner exists', scheduleStart)
  assert.notEqual(ownerStart, -1)
  const scheduleBlock = serverSource.slice(scheduleStart, ownerStart)

  assert.match(scheduleBlock, /setTimeout\(\(\) => \{/)
  assert.match(scheduleBlock, /fleetStore\.backfillSessionEntries/)
  assert.match(scheduleBlock, /SESSION_BACKFILL_STARTUP_DELAY_MS/)
  assert.match(scheduleBlock, /scheduleSessionEntryBackfill\(\)/)
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
  assert.match(terminalShapeSource, /\/api\/agents\?limit=100/)
  assert.equal(terminalShapeSource.includes('/api/state'), false)
})

test('legacy full-store dump endpoints do not perform unbounded reads', () => {
  const storeAgentsStart = fleetRoutesSource.indexOf("router.get('/api/store/agents'")
  assert.notEqual(storeAgentsStart, -1)
  const storeAgentsBlock = fleetRoutesSource.slice(storeAgentsStart, storeAgentsStart + 300)
  assert.match(storeAgentsBlock, /Full agent store dumps are disabled/)
  assert.equal(storeAgentsBlock.includes('getAllAgents()'), false)

  const storeTasksStart = fleetRoutesSource.indexOf("router.get('/api/store/tasks'")
  assert.notEqual(storeTasksStart, -1)
  const storeTasksBlock = fleetRoutesSource.slice(storeTasksStart, storeTasksStart + 300)
  assert.match(storeTasksBlock, /Full task store dumps are disabled/)
  assert.equal(storeTasksBlock.includes('getActiveTasks()'), false)
  assert.equal(storeTasksBlock.includes('getAllTasks'), false)

  const storeAgentsAllStart = serverSource.indexOf("if (type === 'store-agents-all')")
  assert.notEqual(storeAgentsAllStart, -1)
  const storeAgentsAllBlock = serverSource.slice(storeAgentsAllStart, storeAgentsAllStart + 300)
  assert.match(storeAgentsAllBlock, /Full agent store dumps are disabled/)
  assert.equal(storeAgentsAllBlock.includes('getAllAgents()'), false)

  const storeTasksWsStart = serverSource.indexOf("if (type === 'store-tasks')")
  assert.notEqual(storeTasksWsStart, -1)
  const storeTasksWsBlock = serverSource.slice(storeTasksWsStart, storeTasksWsStart + 500)
  assert.match(storeTasksWsBlock, /getActiveTasksPage/)
  assert.equal(storeTasksWsBlock.includes('getActiveTasks()'), false)
  assert.equal(storeTasksWsBlock.includes('getAllTasks'), false)
})

test('agent-launch lookup uses the bounded targeted agent endpoint', () => {
  const registerSource = fs.readFileSync(new URL('../agent-launch/register.mjs', import.meta.url), 'utf8')
  const findAgentStart = registerSource.indexOf('export async function findAgent')
  assert.notEqual(findAgentStart, -1)
  const findAgentBlock = registerSource.slice(findAgentStart, findAgentStart + 700)
  assert.match(findAgentBlock, /\/api\/agents\/lookup\?\$\{params\}/)
  assert.equal(findAgentBlock.includes('/api/store/agents'), false)

  const lookupStart = fleetRoutesSource.indexOf("router.get('/api/agents/lookup'")
  assert.notEqual(lookupStart, -1)
  const lookupBlock = fleetRoutesSource.slice(lookupStart, lookupStart + 1000)
  assert.match(lookupBlock, /provide ids or name, not both/)
  assert.match(lookupBlock, /fleetStore\.findAgent\(name\)/)
})

test('daemon reconnect welcome replays bounded agent events without full roster hydration', () => {
  const helperStart = serverSource.indexOf('function daemonAgentReplayForWelcome')
  assert.notEqual(helperStart, -1)
  const helperEnd = serverSource.indexOf('function sendDaemonAgentReplayContinuation', helperStart)
  assert.notEqual(helperEnd, -1)
  const helperBlock = serverSource.slice(helperStart, helperEnd)

  assert.match(helperBlock, /if \(cursor <= 0\) \{/)
  assert.match(helperBlock, /getAgentsByDaemonKey\(daemonKey\)/)
  const reconnectBranch = helperBlock.slice(helperBlock.indexOf('snapshotOverLimit: false'))
  assert.equal(reconnectBranch.includes('getAgentsByDaemon'), false)
  assert.equal(reconnectBranch.includes('getAgentsByDaemonKey'), false)
  assert.match(reconnectBranch, /reset: false/)

  const terminalResumeStart = serverSource.indexOf('// Resume any active terminal watches for agents on this machine.')
  assert.notEqual(terminalResumeStart, -1)
  const terminalResumeEnd = serverSource.indexOf('// Send daemon-welcome', terminalResumeStart)
  assert.notEqual(terminalResumeEnd, -1)
  const terminalResumeBlock = serverSource.slice(terminalResumeStart, terminalResumeEnd)
  assert.match(terminalResumeBlock, /getAgentsByIds\(watchedAgentIds\)/)
  assert.equal(terminalResumeBlock.includes('getAgentsByDaemon('), false)

  const welcomeStart = serverSource.indexOf("if (type === 'daemon-hello') {")
  assert.notEqual(welcomeStart, -1)
  const welcomeEnd = serverSource.indexOf('// Send persisted backing file watch list to daemon.', welcomeStart)
  assert.notEqual(welcomeEnd, -1)
  const welcomeBlock = serverSource.slice(welcomeStart, welcomeEnd)
  assert.match(welcomeBlock, /daemonAgentReplayForWelcome\(daemonKey, ws\._agentStatusSeq\)/)
  assert.match(welcomeBlock, /agent_status_has_more/)
  assert.equal(welcomeBlock.includes('getAgentsByDaemon(machine_id, env_name)'), false)
})

test('daemon delta welcome preserves existing roster before applying replay events', () => {
  const welcomeStart = daemonSource.indexOf("if (msg.type === 'daemon-welcome')")
  assert.notEqual(welcomeStart, -1)
  const welcomeEnd = daemonSource.indexOf("if (msg.type === 'agent-status-events')", welcomeStart)
  assert.notEqual(welcomeEnd, -1)
  const welcomeBlock = daemonSource.slice(welcomeStart, welcomeEnd)

  assert.match(welcomeBlock, /if \(msg\.agent_status_reset\) agents = msg\.agents \|\| \[\]/)
  assert.match(welcomeBlock, /applyAgentStatusEvents\(msg\.agent_status_events \|\| \[\]\)/)
  assert.match(welcomeBlock, /Math\.max\(agentStatusSeq, msg\.agent_status_seq \|\| 0\)/)
  assert.equal(welcomeBlock.includes('\n    agents = msg.agents || []'), false)

  const eventBatchStart = daemonSource.indexOf("if (msg.type === 'agent-status-events')")
  assert.notEqual(eventBatchStart, -1)
  const eventBatchBlock = daemonSource.slice(eventBatchStart, eventBatchStart + 350)
  assert.match(eventBatchBlock, /applyAgentStatusEvents\(msg\.agent_status_events \|\| \[\]\)/)
  assert.match(eventBatchBlock, /reconcileRoster\('agent-status-events'\)/)
})

test('Codex login registers the harness-provided thread id and daemon ACKs roster deltas', () => {
  assert.match(mcpFleetSource, /process\.env\.CODEX_THREAD_ID/)

  const deltaStart = daemonSource.indexOf("if (msg.type === 'agent-status-event')")
  assert.notEqual(deltaStart, -1)
  const deltaBlock = daemonSource.slice(deltaStart, deltaStart + 700)
  assert.match(deltaBlock, /ackServerDaemonOutboxMessage\(msg\)/)
  assert.match(deltaBlock, /msg\.seq > agentStatusSeq/)
})

test('fleet client buffers reconnect sends and does not bulk-reject pending requests on close', () => {
  assert.match(clientSource, /from ['"]\.\.\/\.\.\/shared\/fleet-browser-transport\.mjs['"]/)
  assert.equal(clientSource.includes('../../shared/fleet-transport.mjs'), false)
  assert.equal(clientSource.includes('../../shared/ws-request-policy.mjs'), false)
  assert.equal(clientSource.includes('../../shared/ws-reconnect-buffer.mjs'), false)
  assert.equal(clientSource.includes('ResilientWS'), false)
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
