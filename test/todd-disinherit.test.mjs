import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(path.join(ROOT, 'bin', 'todd.mjs'), 'utf8')

test('Todd disinherit parses call-them away from target/correction without applying it', () => {
  assert.match(source, /const DISINHERIT_PATTERN = /)
  assert.match(source, /function parseDisinheritCommand/)
  assert.match(source, /after\.match\(\/\\bcall them\\s\+\(\[\\s\\S\]\+\)\$\/i\)/)
  assert.match(source, /correction: beforeCall\.slice\(deictic\[0\]\.length\)/)
  assert.match(source, /correction: \(named\?\.\[2\] \|\| ''\)/)
  assert.doesNotMatch(source, /callRaw/)
  assert.doesNotMatch(source, /renameTo: renameTo \|\| null/)
  assert.doesNotMatch(source, /opts\.renameTo/)
  assert.match(source, /function isDeicticDisinheritTarget/)
  assert.match(source, /this\\s\+\)\?\(\?:guy\|agent\|one\)/)
})

test('Todd disinherit is rename plus fresh bare-name successor, not lineage rotation', () => {
  const body = source.match(/async function handleDisinherit[\s\S]*?\n}\n\nasync function resolveRotateTarget/)?.[0] || ''
  assert.match(body, /const successorName = stripPhase\(agentName\)/)
  assert.match(body, /const originalTask = await activeTaskForAgent\(agentId, agentName\)/)
  assert.match(body, /const renameTo = await chooseDisinheritCatName\(agentId\)/)
  assert.match(body, /await renameAgent\(agentId, renameTo\)/)
  assert.match(body, /fresh:\s*true/)
  assert.match(body, /name:\s*successorName/)
  assert.match(body, /routeAgent:\s*agentId/)
  assert.ok(body.indexOf('const spawnResult = await spawnAgent') < body.indexOf("sendChat(agentId, `I've named you ${renameTo}"), 'self-name message must not gate successor spawn')
  assert.match(body, /I've named you \$\{renameTo\} to make space for your successor\. Give yourself a new name\./)
  assert.match(body, /The last attempt failed\. We're trying again\. Here's your brief\./)
  assert.match(body, /Skip's original instructions to the last agent:/)
  assert.match(body, /Skip's specific instructions for you:/)
  assert.match(body, /const correction = opts\.correction \|\| ''/)
  assert.match(body, /nothing else is inherited/)
  assert.match(body, /Disinherit complete/)
  assert.doesNotMatch(body, /lineage-transition/)
  assert.doesNotMatch(body, /lineage-make-room/)
  assert.doesNotMatch(body, /advisor/)
  assert.doesNotMatch(body, /kill-session/)
})

test('Todd disinherit fetches the incumbent active task from store tasks', () => {
  const taskBody = source.match(/async function activeTaskForAgent[\s\S]*?\n}\n\nasync function renameAgent/)?.[0] || ''
  assert.match(taskBody, /getJson\('\/api\/store\/tasks', \[\]\)/)
  assert.match(taskBody, /t\.agent === agentId \|\| t\.agent === agentName/)
  assert.match(taskBody, /t\.status !== 'done'/)
})

test('Todd disinherit renames through the friendly-name API and keeps a swappable fallback pool', () => {
  assert.match(source, /const DISINHERIT_CAT_NAMES = \['Whiskers', 'Mittens', 'Felix', 'Salem', 'Tom', 'Garfield', 'Simba'\]/)
  assert.match(source, /async function renameAgent\(agentId, newName\)/)
  assert.match(source, /postJson\('\/api\/rename', \{ agent: agentId, name: newName \}\)/)
  assert.match(source, /async function chooseDisinheritCatName/)
  assert.match(source, /\/api\/check-name\?name=\$\{encodeURIComponent\(name\)\}&exclude=\$\{encodeURIComponent\(agentId\)\}/)
})

test('Todd routes only Skip-addressed disinherit through the cancelable scheduler', () => {
  const dispatchBody = source.match(/\/\/ Disinherit[\s\S]*?\/\/ Handoff/)?.[0] || ''
  assert.match(dispatchBody, /const disinheritAddressedBySkip = from_id === OWNER_ID/)
  assert.match(dispatchBody, /addressedBefore\(DISINHERIT_PATTERN\)/)
  assert.match(dispatchBody, /to_id === AGENT_ID && DISINHERIT_PATTERN\.test\(text\)/)
  assert.match(dispatchBody, /resolveDisinheritTarget\(text, to_id\)/)
  assert.match(dispatchBody, /scheduleAction\('disinherit', 'Disinheriting agent'/)
  assert.match(dispatchBody, /handleDisinherit\(disinheritTarget, text, \{ requestedBy: from_id, correction \}\)/)
})

test('Todd rotate and handoff Type 1/2 routes remain present and separate', () => {
  const dispatchBody = source.match(/\/\/ Rotate[\s\S]*?\/\/ QA dispatch/)?.[0] || ''
  assert.match(dispatchBody, /scheduleAction\('rotate', 'Rotating agent'/)
  assert.match(dispatchBody, /handleRotate\(rotateTarget, text, \{ requestedBy: from_id \}\)/)
  assert.match(dispatchBody, /scheduleAction\(direct \? 'handoff-direct' : 'handoff'/)
  assert.match(dispatchBody, /handleHandoff\(handoffTarget, text, \{ requestedBy: from_id \}\)/)
})
