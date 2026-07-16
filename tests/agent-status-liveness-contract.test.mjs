import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('server runtime status records daemon pane status separately from liveness', () => {
  const source = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const daemonHandler = source.indexOf('async function handleDaemonWsMessage')
  const start = source.indexOf("if (type === 'agent-status')", daemonHandler)
  const end = source.indexOf("if (type === 'agent-liveness')", start)
  const handler = source.slice(start, end)

  assert.ok(daemonHandler >= 0 && start > daemonHandler && end > start)
  assert.match(handler, /runtimeStatusStore\.updateActivity\(agentId, state/)
  assert.match(handler, /state === 'hibernating'\) markAgentNotAlive\(agentId, \{ source: 'daemon-agent-status', unknown: true/)
  assert.match(handler, /else markAgentAlive\(agentId, Date\.parse\(ts\) \|\| Date\.now\(\), \{ source: 'daemon-agent-status'/)
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
