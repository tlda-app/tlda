import assert from 'node:assert/strict'
import test from 'node:test'

import { assertCodexKickoffDelivered } from '../agent-launch/launch-result.mjs'

test('a Codex mint fails when its fleet kickoff cannot be delivered', async () => {
  assert.throws(
    () => assertCodexKickoffDelivered(false, 'fleet-unclaimed-mint'),
    error => error?.code === 'launch-failed' && /kickoff/.test(error.message),
  )
})
