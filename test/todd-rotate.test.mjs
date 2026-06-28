import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(path.join(ROOT, 'bin', 'todd.mjs'), 'utf8')

test('Todd rotate command uses fresh route-agent spawn with no briefing handoff', () => {
  assert.match(source, /const ROTATE_PATTERN = /)
  assert.match(source, /async function handleRotate/)
  assert.match(source, /fresh:\s*true/)
  assert.match(source, /routeAgent:\s*agentId/)
  assert.match(source, /lineage-transition/)
  assert.doesNotMatch(
    source.match(/async function handleRotate[\s\S]*?\n}\n\nasync function handleHandoff/)?.[0] || '',
    /handoff-ready|tasks\/delegate|briefingName|pendingHandoffs/,
  )
})
