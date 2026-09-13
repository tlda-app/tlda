import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { assertCodexKickoffDelivered, recordKickoffFailure } from '../agent-launch/launch-result.mjs'

test('a Codex mint fails when its fleet kickoff cannot be delivered', async () => {
  assert.throws(
    () => assertCodexKickoffDelivered(false, 'fleet-unclaimed-mint'),
    error => error?.code === 'launch-failed' && /kickoff/.test(error.message),
  )
})

// The husks this logging exists for are indistinguishable from an agent nobody
// started, so the thing under test is that the reason OUTLIVES the process that
// threw. Asserting on the file, not on the call returning true.
test('an undelivered kickoff writes its reason to the crash log', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kickoff-log-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const crashLogPath = path.join(dir, 'nested', 'agent.log')

  assert.throws(() => assertCodexKickoffDelivered(false, 'fleet-parked-mint', {
    crashLogPath,
    detail: { name: 'parked-mint', fleet_id: 'fleet:dead1234', path: 'mint' },
  }))

  const written = fs.readFileSync(crashLogPath, 'utf8')
  assert.match(written, /codex-kickoff-not-delivered/)
  assert.match(written, /fleet-parked-mint/)
  assert.match(written, /fleet:dead1234/)
  // The record has to name which launch path produced it: the same husk shape
  // is reachable from mint, respawn and refresh, and they are fixed differently.
  assert.match(written, /"path":"mint"/)
})

// The control. A rule that fires on a healthy launch gets switched off, and then
// catches nothing -- so a delivered kickoff must leave no file at all.
test('a delivered kickoff writes nothing', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kickoff-log-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const crashLogPath = path.join(dir, 'agent.log')

  assertCodexKickoffDelivered(true, 'fleet-healthy-mint', { crashLogPath })

  assert.equal(fs.existsSync(crashLogPath), false)
})

// A launch is already failing by the time this runs. A diagnostic that throws
// here would replace the real failure with a worse one, so an unwritable path
// has to be survivable rather than correct.
test('an unwritable crash log does not mask the launch failure', async () => {
  assert.equal(recordKickoffFailure('fleet-x', '/proc/nonexistent/nope.log'), false)
  assert.equal(recordKickoffFailure('fleet-x', null), false)
  assert.throws(
    () => assertCodexKickoffDelivered(false, 'fleet-x', { crashLogPath: '/proc/nonexistent/nope.log' }),
    error => error?.code === 'launch-failed',
  )
})
