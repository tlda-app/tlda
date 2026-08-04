import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('daemon hibernating status is negative liveness evidence', () => {
  const source = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const handlerStart = source.indexOf('async function handleDaemonWsMessage')
  const statusStart = source.indexOf("if (type === 'agent-status')", handlerStart)
  const statusEnd = source.indexOf('\n  if (type === ', statusStart + 1)
  const statusBranch = source.slice(statusStart, statusEnd)

  assert.ok(handlerStart >= 0 && statusStart > handlerStart && statusEnd > statusStart)
  assert.match(statusBranch, /state === 'hibernating'/)
  assert.match(statusBranch, /markAgentNotAlive\(agentId/)
  assert.match(statusBranch, /else \{\s+markAgentAlive\(agentId/)
})
