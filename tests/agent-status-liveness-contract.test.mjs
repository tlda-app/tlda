import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('server liveness follows daemon process status transitions', () => {
  const source = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const daemonHandler = source.indexOf('async function handleDaemonWsMessage')
  const start = source.indexOf("if (type === 'agent-status')", daemonHandler)
  const end = source.indexOf("if (type === 'agent-liveness')", start)
  const handler = source.slice(start, end)

  assert.ok(daemonHandler >= 0 && start > daemonHandler && end > start)
  assert.match(handler, /state === 'hibernating'\) markAgentNotAlive\(agentId\)/)
  assert.match(handler, /else markAgentAlive\(agentId\)/)
})
