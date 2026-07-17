import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('server runtime status records daemon pane status separately from liveness', () => {
  const source = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const daemonHandler = source.indexOf('async function handleDaemonWsMessage')
  const start = source.indexOf("if (type === 'agent-status')", daemonHandler)
  const end = source.indexOf("if (type === 'agent-lifecycle')", start)
  const handler = source.slice(start, end)

  assert.ok(daemonHandler >= 0 && start > daemonHandler && end > start)
  assert.match(handler, /runtimeStatusStore\.updateActivity\(agentId, state/)
  assert.doesNotMatch(handler, /markAgentAlive\(/)
  assert.doesNotMatch(handler, /markAgentNotAlive\(/)
})

test('server runtime status does not consume daemon liveness as lifecycle truth', () => {
  const source = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const daemonHandler = source.indexOf('async function handleDaemonWsMessage')
  const start = source.indexOf("if (type === 'agent-liveness')", daemonHandler)
  const end = source.indexOf("if (type === 'agent-activity')", start)
  const handler = source.slice(start, end)

  assert.ok(daemonHandler >= 0 && start > daemonHandler && end > start)
  assert.doesNotMatch(handler, /markAgentAlive\(/)
  assert.doesNotMatch(handler, /markAgentNotAlive\(/)
})

test('server runtime status records explicit check-alive replies as unknown diagnostics', () => {
  const source = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const recorderStart = source.indexOf('function recordExplicitCheckAliveLiveness')
  const recorderEnd = source.indexOf('function refreshRuntimeRoutesForDaemon', recorderStart)
  const recorder = source.slice(recorderStart, recorderEnd)

  assert.ok(recorderStart >= 0 && recorderEnd > recorderStart)
  assert.match(recorder, /runtimeStatusStore\.markUnknown\(agentId, 'daemon-check-alive'/)
  assert.doesNotMatch(recorder, /markAgentAlive\(/)
  assert.doesNotMatch(recorder, /markAgentNotAlive\(/)

  const taskRenudgeStart = source.indexOf('async function drainTaskWakeQueue')
  const taskRenudgeEnd = source.indexOf('const decision = spawnLibrarian.decideWake', taskRenudgeStart)
  const taskRenudge = source.slice(taskRenudgeStart, taskRenudgeEnd)
  assert.match(taskRenudge, /recordExplicitCheckAliveLiveness\(\{ \.\.\.liveness, agent_id: liveness\.agent_id \|\| agentId \}\)/)

  const checkAliveStart = source.indexOf("if (type === 'check-alive')")
  const checkAliveEnd = source.indexOf("if (type === 'plan-mode-respond')", checkAliveStart)
  const checkAlive = source.slice(checkAliveStart, checkAliveEnd)
  assert.match(checkAlive, /const liveness = livenessFromCheckAliveResult/)
  assert.match(checkAlive, /recordExplicitCheckAliveLiveness\(liveness\)\s+reply\(liveness\)/)
})

test('server runtime status consumes only daemon agent-lifecycle as runtime authority', () => {
  const source = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const daemonHandler = source.indexOf('async function handleDaemonWsMessage')
  const start = source.indexOf("if (type === 'agent-lifecycle')", daemonHandler)
  const end = source.indexOf("if (type === 'agent-liveness')", start)
  const handler = source.slice(start, end)

  assert.ok(daemonHandler >= 0 && start > daemonHandler && end > start)
  assert.match(handler, /lifecycleMatchesCurrentSeat\(event\)/)
  assert.match(handler, /event\.state === 'runtime-alive' && match\.ok/)
  assert.match(handler, /markAgentAlive\(event\.agent_id, atMs, detail\)/)
  assert.match(handler, /completeSpawnMailboxesFromLifecycle\(event\)/)
  assert.match(handler, /event\.state === 'runtime-exited' && match\.ok/)
  assert.match(handler, /markAgentNotAlive\(event\.agent_id/)
})
