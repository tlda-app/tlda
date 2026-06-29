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
