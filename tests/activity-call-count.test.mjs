/**
 * A tool call counts once.
 *
 * Every call is recorded twice — when it starts and when its result lands — with
 * the same name and the same arguments. The display merged those two into one
 * row and counted them as two calls, so every `×N` in the activity feed was
 * double. Skip's poll rows all read `×2` and never `×3`, which is what a
 * doubled count of one call looks like.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { dedupTools } from '../src/fleet/activity-render.mjs'

const call = (name, arg, status, extra = {}) => ({
  _toolName: name,
  _toolArg: arg,
  _toolInput: { command: arg },
  _toolStatus: status,
  ...extra,
})

test('a started/completed pair is one call, not two', () => {
  const rows = dedupTools([
    call('Bash', 'npm run build', 'started'),
    call('Bash', 'npm run build', 'completed'),
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]._count, 1, 'one command was run once')
  assert.equal(rows[0]._toolStatus, 'completed', 'the row knows the call finished')
})

test('the same command genuinely run twice still counts twice', () => {
  const rows = dedupTools([
    call('Bash', 'npm test', 'started'),
    call('Bash', 'npm test', 'completed'),
    call('Bash', 'npm test', 'started'),
    call('Bash', 'npm test', 'completed'),
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]._count, 2, 'two runs of one command')
})

test('a completion carries its duration onto the row it completes', () => {
  const rows = dedupTools([
    call('Bash', 'sleep 5', 'started'),
    call('Bash', 'sleep 5', 'completed', { _toolDuration: 5001 }),
  ])
  assert.equal(rows[0]._count, 1)
  assert.equal(rows[0]._toolDuration, 5001)
})

test('rows with no status behave as before — nothing depends on it being present', () => {
  const rows = dedupTools([
    { _toolName: 'Bash', _toolArg: 'ls', _toolInput: { command: 'ls' } },
    { _toolName: 'Bash', _toolArg: 'ls', _toolInput: { command: 'ls' } },
  ])
  assert.equal(rows[0]._count, 2)
})
