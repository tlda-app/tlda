import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('pane-status classification is display-only and never publishes liveness', () => {
  // Skip's 7/18 directive: the pane classifier and the daemon's process
  // observation both published the seat-alive fact and fought over it.
  // The duplicate publisher is DELETED, not refereed: agent-status updates
  // display state only; liveness truth comes from agent-liveness/login.
  const source = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const daemonHandler = source.indexOf('async function handleDaemonWsMessage')
  const start = source.indexOf("if (type === 'agent-status')", daemonHandler)
  const end = source.indexOf("if (type === 'agent-liveness')", start)
  const handler = source.slice(start, end)

  assert.ok(daemonHandler >= 0 && start > daemonHandler && end > start)
  assert.match(handler, /runtimeStatusStore\.updateActivity\(agentId, state/)
  assert.doesNotMatch(handler, /markAgentNotAlive/)
  assert.doesNotMatch(handler, /markAgentAlive/)
})

test('server runtime status records explicit daemon liveness negatives immediately', () => {
  const source = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const daemonHandler = source.indexOf('async function handleDaemonWsMessage')
  const start = source.indexOf("if (type === 'agent-liveness')", daemonHandler)
  const end = source.indexOf("if (type === 'agent-activity')", start)
  const handler = source.slice(start, end)

  assert.ok(daemonHandler >= 0 && start > daemonHandler && end > start)
  assert.match(handler, /state === 'dead' \|\| state === 'wedged'/)
  assert.match(handler, /markAgentNotAlive\(agent_id, \{\s*source: 'daemon-agent-liveness'/)
})

test('server runtime status records explicit check-alive replies before consumers use them', () => {
  const source = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const recorderStart = source.indexOf('function recordExplicitCheckAliveLiveness')
  const recorderEnd = source.indexOf('function refreshRuntimeRoutesForDaemon', recorderStart)
  const recorder = source.slice(recorderStart, recorderEnd)

  assert.ok(recorderStart >= 0 && recorderEnd > recorderStart)
  assert.match(recorder, /markAgentAlive\(agentId, atMs, detail\)/)
  assert.match(recorder, /markAgentNotAlive\(agentId, detail\)/)
  assert.match(recorder, /markAgentNotAlive\(agentId, \{ \.\.\.detail, unknown: true \}\)/)

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
