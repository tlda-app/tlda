// Step 4 of the notification proposal: *x* is configuration, not code.
//
// The unit rule and the ordering constraint are the two things a future editor
// can break silently, so both are pinned here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

import { parseDurationMs, parseBatchWindowMs } from '../../shared/inbox-attention.mjs'

const DEPLOYMENTS = ['live', 'rc', 'stable', 'pic', 'talk', 'overleaf-test']
const repoRoot = join(import.meta.dirname, '..', '..')

// The MCP's serial budget for handling one notice: deliverChannelNotice then
// acknowledgeWakeChannelNotice, each capped at 1000ms, one after the other.
// `ackTimeout` below this scores a fully successful delivery as a timeout.
const MCP_SERIAL_BUDGET_MS = 2000

test('every deployment declares an ack timeout, with a unit', () => {
  for (const env of DEPLOYMENTS) {
    const config = YAML.parse(readFileSync(join(repoRoot, 'config', 'deployments', env, 'server.yaml'), 'utf8'))
    const declared = config?.notifications?.ackTimeout
    assert.ok(declared != null, `${env}/server.yaml must declare notifications.ackTimeout`)
    assert.equal(typeof declared, 'string', `${env}: the unit is part of the value, so this is a string, not ${typeof declared}`)
    const ms = parseDurationMs(declared)
    assert.ok(ms, `${env}: ${JSON.stringify(declared)} is not a duration this parser accepts`)
    assert.ok(
      ms > MCP_SERIAL_BUDGET_MS,
      `${env}: ackTimeout ${declared} (${ms}ms) must EXCEED the MCP's serial notice budget (${MCP_SERIAL_BUDGET_MS}ms). ` +
      'At or below it, a delivery that fully succeeded is scored as a timeout and provokes the daemon path anyway — ' +
      'the duplicate becomes structural. Move the two MCP budgets first.',
    )
  }
})

// A bare number is an error, not a default in some unit you have to guess. The
// server throws on it rather than falling back, because an unset or misspelled
// value presenting as a working default is the history `server.yaml`'s own
// header records.
test('a bare number is not a duration', () => {
  assert.equal(parseDurationMs('5'), null)
  assert.equal(parseDurationMs(5), null)
  assert.equal(parseDurationMs(''), null)
  assert.equal(parseDurationMs(null), null)
  assert.equal(parseDurationMs('soon'), null)
})

test('units are honoured', () => {
  assert.equal(parseDurationMs('5s'), 5000)
  assert.equal(parseDurationMs('250ms'), 250)
  assert.equal(parseDurationMs('2m'), 120000)
  assert.equal(parseDurationMs('1 hour'), 3600000)
})

// One grammar, one implementation. `batch(15s)` is the precedent this borrows,
// so it had better be literally the same code — two parsers for one notation is
// how the unit rule ends up enforced in one place and not the other.
test('the batch policy and the ack timeout share a parser', () => {
  for (const spec of ['5s', '250ms', '2m', '1 hour', '90 seconds']) {
    assert.equal(
      parseBatchWindowMs(`batch(${spec})`),
      parseDurationMs(spec),
      `batch(${spec}) and a bare ${spec} must agree`,
    )
  }
  for (const bad of ['15', 'soon', '']) {
    assert.equal(parseBatchWindowMs(`batch(${bad})`), null)
    assert.equal(parseDurationMs(bad), null)
  }
})
