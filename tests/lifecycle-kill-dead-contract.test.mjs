import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')

test('kill marks the agent dead while hibernate leaves it resumable', () => {
  const httpKill = source.slice(source.indexOf("app.post('/api/kill-session'"), source.indexOf("app.post('/api/plan-mode-respond'"))
  const wsKill = source.slice(source.indexOf("if (type === 'kill-session')"), source.indexOf("// ---- hibernate-session ----"))
  const hibernate = source.slice(source.indexOf("if (type === 'hibernate-session')"), source.indexOf("// ---- restart-agent-mcp ----"))

  for (const branch of [httpKill, wsKill]) {
    assert.match(branch, /status: RUNTIME_STATUS\.DEAD/)
    assert.match(branch, /await fleetStore\.markDead\(agent\.id\)/)
  }
  assert.doesNotMatch(hibernate, /markDead\(/)
  assert.doesNotMatch(hibernate, /RUNTIME_STATUS\.DEAD/)
})
