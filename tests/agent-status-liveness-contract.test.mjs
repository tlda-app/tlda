import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('server liveness follows daemon process status transitions', () => {
  const source = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const start = source.indexOf("if (type === 'agent-status')")
  const end = source.indexOf('// ---- tlda-monitor', start)
  const handler = source.slice(start, end)

  assert.match(handler, /state === 'hibernating'\) markAgentNotAlive\(agentId\)/)
  assert.match(handler, /else markAgentAlive\(agentId\)/)
})
