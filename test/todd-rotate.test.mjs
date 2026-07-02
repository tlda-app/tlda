import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(path.join(ROOT, 'bin', 'todd.mjs'), 'utf8')

test('Todd rotate command rotates in place with brief and advisor instructions', () => {
  assert.match(source, /const ROTATE_PATTERN = /)
  assert.match(source, /me\|myself\|us/)
  assert.match(source, /async function handleRotate/)
  assert.match(source, /fresh:\s*true/)
  assert.match(source, /routeAgent:\s*agentId/)
  assert.match(source, /lineage-transition'[\s\S]*phase:\s*'day'/)
  const rotateBody = source.match(/async function handleRotate[\s\S]*?\n}\n\nasync function resolveRotateTarget/)?.[0] || ''
  assert.match(rotateBody, /tasks\/delegate/)
  assert.match(rotateBody, /Rotation brief from/)
  assert.match(rotateBody, /advisor-only/)
  assert.match(rotateBody, /Advise only when consulted/)
})

test('Todd accepts agent-facing self-rotation commands', () => {
  assert.match(source, /const rotateAddressedByAgent = /)
  assert.match(source, /to_id === AGENT_ID/)
  assert.match(source, /fallbackTarget = rotateAddressedByAgent \? from_id : null/)
  assert.match(source, /requestedBy: from_id/)
  assert.match(source, /me\|myself\|us/)
})

test('Todd direct handoff spawns a routed fresh worker and keeps outgoing agent advisor-only', () => {
  const directBody = source.match(/if \(\s*\/\\bdirect[\s\S]*?\n  }\n\n  sendChat\(OWNER_ID, `Starting handoff/)?.[0] || ''
  assert.match(directBody, /fresh:\s*true/)
  assert.match(directBody, /routeAgent:\s*agentId/)
  assert.match(directBody, /handoff-direct-lineage-failed/)
  assert.match(directBody, /advisor-only/)
  assert.match(directBody, /Make a plan, send Skip a quick summary \(what you understand, what's open, what you'll start on\), then—unless Skip said to wait—get to work\./)
  assert.doesNotMatch(directBody, /Wait for Skip's confirmation before diving in/)
  assert.doesNotMatch(directBody, /promot(?:e|ing|ed) (?:it )?to manager/i)
  assert.doesNotMatch(directBody, /You're being promoted to manager/)
  assert.doesNotMatch(directBody, /now (?:your|its) manager/)
})

test('Todd briefing handoff pickup spawn routes through the outgoing source agent', () => {
  const pickupBody = source.match(/async function handleHandoffReady[\s\S]*?\n  spawnPickup\(\)/)?.[0] || ''
  assert.match(pickupBody, /const pickupSpawnSpec = handoffInfo\.spawnSpec \|\| \{\}/)
  assert.match(pickupBody, /name:\s*pickupName/)
  assert.match(pickupBody, /cwd:\s*handoffInfo\.originalCwd/)
  assert.match(pickupBody, /fresh:\s*true/)
  assert.match(pickupBody, /routeAgent:\s*handoffInfo\.originalAgentId/)
  assert.match(pickupBody, /logDecision\(handoffInfo\.originalAgentId,[\s\S]*routeAgent:\s*handoffInfo\.originalAgentId/)
  assert.match(pickupBody, /You are replacing/)
  assert.match(pickupBody, /Make a plan, send Skip a quick summary \(what you understand, what's open, what you'll start on\), then—unless Skip said to wait—get to work\./)
  assert.doesNotMatch(pickupBody, /Wait for Skip's confirmation before diving in/)
  assert.doesNotMatch(pickupBody, /promot(?:e|ing|ed) (?:it )?to manager/i)
  assert.doesNotMatch(pickupBody, /You're being promoted to manager/)
  assert.doesNotMatch(pickupBody, /now (?:your|its) manager/)
})

test('Todd normal handoff routes both briefing and pickup through the outgoing source agent', () => {
  const handoffBody = source.match(/async function handleHandoff[\s\S]*?\n}\n\nasync function handleHandoffReady/)?.[0] || ''
  assert.match(handoffBody, /requestedBy = opts\.requestedBy \|\| OWNER_ID/)
  assert.match(handoffBody, /requestedByOutgoing = requestedBy === agentId/)
  assert.match(handoffBody, /name:\s*briefingName,\s*cwd:\s*agentCwd,\s*fresh:\s*true,\s*routeAgent:\s*agentId/)
  assert.match(handoffBody, /pendingHandoffs\.set\(briefingName,[\s\S]*requestedBy/)
  assert.match(handoffBody, /logDecision\(agentId, 'handoff-initiated'[\s\S]*routeAgent:\s*agentId[\s\S]*requestedBy/)
  assert.match(handoffBody, /Handoff message from \$\{requesterLabel\}/)
})

test('Todd accepts agent-facing self-handoff but targets only the requesting agent', () => {
  const dispatchBody = source.match(/const handoffAddressedBySkip[\s\S]*?\/\/ QA dispatch/)?.[0] || ''
  assert.match(dispatchBody, /const handoffAddressedBySkip = from_id === OWNER_ID/)
  assert.match(dispatchBody, /const handoffAddressedByAgent = from_id && from_id !== OWNER_ID && from_id !== AGENT_ID && to_id === AGENT_ID/)
  assert.match(dispatchBody, /HANDOFF_PATTERN\.test\(text\)/)
  assert.match(dispatchBody, /const handoffTarget = handoffAddressedByAgent \? from_id : to_id/)
  assert.match(dispatchBody, /handleHandoff\(handoffTarget, text, \{ requestedBy: from_id \}\)/)
  assert.match(dispatchBody, /scheduleAction\([^]*handoffTarget\)/)
})

test('Todd initializes the fleet event cursor before registering on websocket open', () => {
  const openBody = source.match(/ws\.on\('open', async \(\) => \{[\s\S]*?\n  \}\)/)?.[0] || ''
  assert.match(openBody, /await initializeFleetCursor\(\)/)
  assert.match(openBody, /await initializeFleetCursor\(\)[\s\S]*register\(\)/)
  assert.match(openBody, /register\(\)[\s\S]*catchUpFleetEvents\(\)/)
})
