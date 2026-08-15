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

test('reanimate restores dead after wake failure even when owner route remains', () => {
  const reanimateStart = source.indexOf('async function reanimateAgent(')
  assert.notEqual(reanimateStart, -1, 'reanimateAgent should exist')

  const wakeStart = source.indexOf("spawnResult = await sendDaemonDurable(daemonKey, 'wake'", reanimateStart)
  assert.notEqual(wakeStart, -1, 'reanimate should wake through the durable daemon route')

  const routeWait = source.indexOf('const nextSeat = await waitForAgentDaemonRoute(before.id)', wakeStart)
  assert.notEqual(routeWait, -1, 'reanimate should wait for the revived route after wake')

  const wakeFailureBlock = source.slice(wakeStart, routeWait)
  const catchStart = wakeFailureBlock.indexOf('} catch (e) {')
  assert.notEqual(catchStart, -1, 'wake failure should be handled before waiting for the route')

  const catchBody = wakeFailureBlock.slice(catchStart)
  const restoreDead = catchBody.indexOf('await fleetStore.markDead(before.id)')
  const throwFailure = catchBody.indexOf('throw e')
  assert.notEqual(restoreDead, -1, 'failed wake should restore the prior dead state')
  assert.notEqual(throwFailure, -1, 'failed wake should still report the original failure')
  assert.ok(restoreDead < throwFailure, 'dead state must be restored before rethrowing')
  assert.match(
    catchBody,
    /markAgentNotAlive\(before\.id, \{ source: 'reanimate', reason: `wake failed: \$\{e\.message\}` \}\)/
  )
  assert.match(catchBody, /broadcastState\(before\.id\)/)
  assert.doesNotMatch(catchBody, /getAgentDaemonRoute/)
  assert.doesNotMatch(catchBody, /if \(!currentRoute\)/)
})
