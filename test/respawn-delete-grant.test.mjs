// Guards the respawn-delete fix: rpcSpawn must only preallocate/roll-back a grant
// for a FRESHLY-MINTED id (fresh/session, no caller agent_id). A respawn carries an
// existing agent_id whose grant is durable — a launch failure must never delete it
// (that wiped fleet:7725aeba's grant repeatedly, per scratch/respawn-delete-grant-bug.md).
//
// rpcSpawn dynamic-imports the launcher and spawns real processes, so its launch-failure
// path isn't cleanly unit-testable without a DI seam; this source-assertion pins the
// invariant against regression (reverting the guard to `preallocatedAgentId`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const daemon = () => readFileSync(path.join(ROOT, 'bin', 'fleet-daemon.mjs'), 'utf8')

test('rpcSpawn defines mintedThisCall = fresh/session AND no caller agent_id', () => {
  const src = daemon()
  assert.match(src, /const mintedThisCall = !agent_id && \(spawnMode === 'fresh' \|\| spawnMode === 'session'\)/)
})

test('rpcSpawn gates the grant set + all deletes on mintedThisCall, never preallocatedAgentId', () => {
  const src = daemon()
  // the pre-launch grant set is minted-only
  assert.match(src, /if \(mintedThisCall\) \{\s*await permissionLedger\.set\(preallocatedAgentId/)
  // every rollback delete is minted-only
  const mintedDeletes = src.match(/if \(mintedThisCall\) await permissionLedger\.delete\(preallocatedAgentId\)/g) || []
  assert.equal(mintedDeletes.length, 3, 'all three launch-failure deletes must be minted-only')
  // and NONE remain gated on preallocatedAgentId (the bug: would delete a respawn seat's grant)
  assert.equal(src.includes('if (preallocatedAgentId) await permissionLedger.delete'), false)
  assert.equal(src.includes('if (preallocatedAgentId) {\n      await permissionLedger.set'), false)
})
