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

test('reanimate leaves the agent hibernating after wake failure; dead is never inferred', () => {
  const reanimateStart = source.indexOf('async function reanimateAgent(')
  assert.notEqual(reanimateStart, -1, 'reanimateAgent should exist')

  const wakeStart = source.indexOf("spawnResult = await sendDaemonDurable(daemonKey, 'wake'", reanimateStart)
  assert.notEqual(wakeStart, -1, 'reanimate should wake through the durable daemon route')

  const routeWait = source.indexOf('const nextSeat = await waitForAgentDaemonRoute(before.id)', wakeStart)
  assert.notEqual(routeWait, -1, 'reanimate should wait for the revived route after wake')

  const authorityBlock = source.slice(reanimateStart, wakeStart)
  assert.match(authorityBlock, /const ownerRoute = await fleetStore\.getAgentDaemonRoute\?\.\(before\.id\)/)
  assert.match(authorityBlock, /const daemonKey = ownerRoute\?\.daemon_key \|\| null/)
  assert.doesNotMatch(authorityBlock, /before\.daemon_key/)
  assert.doesNotMatch(authorityBlock, /before\.machine_id/)
  assert.doesNotMatch(authorityBlock, /before\.env_name/)

  const wakeFailureBlock = source.slice(wakeStart, routeWait)
  const catchStart = wakeFailureBlock.indexOf('} catch (e) {')
  assert.notEqual(catchStart, -1, 'wake failure should be handled before waiting for the route')

  const catchBody = wakeFailureBlock.slice(catchStart)
  // Skip 2026-08-19, implemented by 770f3f375: never infer death — a wake
  // that fails leaves a live row with no process, which is what hibernating
  // already means. A markDead here would be an unrequested write of the one
  // flag only a request may set.
  assert.doesNotMatch(catchBody, /markDead\(/, 'failed wake must not re-mark the agent dead')
  assert.match(
    catchBody,
    /markAgentNotAlive\(before\.id, \{ source: 'reanimate', reason: `wake phase failed: \$\{e\.message\}` \}\)/
  )
  assert.match(catchBody, /broadcastState\(before\.id\)/)
  assert.match(catchBody, /throw new Error\(/)
  assert.match(catchBody, /Agent left hibernating/)
  assert.doesNotMatch(catchBody, /getAgentDaemonRoute/)
  assert.doesNotMatch(catchBody, /if \(!currentRoute\)/)
})
