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
// Loaded through the REAL validator, not `YAML.parse`. The first version of
// this test parsed the file directly and passed while every deployment's
// server.yaml would have thrown at startup: `notifications` was not in
// SERVER_CONFIG_TOP_LEVEL_KEYS, which is an allowlist. The test was a proxy for
// the load path instead of the load path, and it hid the one bug that mattered.
import { validateServerConfigTopLevel } from '../../shared/daemon-config-schema.mjs'

const DEPLOYMENTS = ['live', 'rc', 'stable', 'pic', 'talk', 'overleaf-test']
const repoRoot = join(import.meta.dirname, '..', '..')

// The MCP's serial budget for handling one notice: deliverChannelNotice then
// acknowledgeWakeChannelNotice, each capped at 1000ms, one after the other.
// `ackTimeout` below this scores a fully successful delivery as a timeout.
const MCP_SERIAL_BUDGET_MS = 2000

test('every deployment declares an ack timeout, with a unit', () => {
  for (const env of DEPLOYMENTS) {
    const raw = YAML.parse(readFileSync(join(repoRoot, 'config', 'deployments', env, 'server.yaml'), 'utf8'))
    // Throws if the file would not load — which is the assertion, not a step
    // towards one.
    const config = validateServerConfigTopLevel(raw, `${env}/server.yaml`)
    const declared = config?.notifications?.ackTimeout
    assert.ok(declared != null, `${env}/server.yaml must declare notifications.ackTimeout`)
    assert.equal(typeof declared, 'string', `${env}: the unit is part of the value, so this is a string, not ${typeof declared}`)
    const ms = parseDurationMs(declared)
    assert.ok(ms, `${env}: ${JSON.stringify(declared)} is not a duration this parser accepts`)
  }
})

// The value is settled, so this asserts the constraint rather than pinning the
// number. An earlier version of this test pinned 2s instead — that was correct
// while the decision was open, because asserting a property the system did not
// have would have meant a red suite standing in for a question. The question is
// closed and the constraint is now true, so the constraint is what gets checked.
test('every deployment ack timeout exceeds the MCP serial notice budget', () => {
  for (const env of DEPLOYMENTS) {
    const config = YAML.parse(readFileSync(join(repoRoot, 'config', 'deployments', env, 'server.yaml'), 'utf8'))
    const declared = config?.notifications?.ackTimeout
    const ms = parseDurationMs(declared)
    assert.ok(
      ms > MCP_SERIAL_BUDGET_MS,
      `${env}: ackTimeout ${declared} (${ms}ms) must EXCEED the MCP's serial notice budget (${MCP_SERIAL_BUDGET_MS}ms) — ` +
      'deliverChannelNotice (≤1000ms) then acknowledgeWakeChannelNotice (≤1000ms), one after the other, plus the trip ' +
      'out and the ack back. At or below it, a delivery that fully succeeded is scored as `mcp-ack-timeout`, which is ' +
      'the same thing a wedged process produces, so a healthy agent cannot be told from a dead one. ' +
      'Move the two MCP budgets before lowering this.',
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

// ─── The key has to be in the schema, or the server does not start ──────────
//
// server.yaml's top-level keys are a CLOSED allow-list and an unknown one
// throws. `loadServerConfig()` runs at MODULE SCOPE in unified-server.mjs, so a
// deployment that declares `notifications:` without the schema entry does not
// degrade — the process exits on boot. The same omission on the daemon side took
// the live daemon down for 25 minutes on 2026-07-25, per the comment on
// DAEMON_CONFIG_TOP_LEVEL_KEYS, and it died on its next restart rather than at
// the moment of the change, which is what made it hard to attribute.
//
// The first version of this step declared the key in six deployment files and
// never added it to the schema. It was reverted before any deploy, so the crash
// never happened.

test('the deployment configs this repo ships actually load', () => {
  for (const env of DEPLOYMENTS) {
    const raw = YAML.parse(readFileSync(join(repoRoot, 'config', 'deployments', env, 'server.yaml'), 'utf8'))
    assert.doesNotThrow(
      () => validateServerConfigTopLevel(raw, `${env}/server.yaml`),
      `${env}/server.yaml does not pass the server config schema — the server would not start`,
    )
  }
})

test('a malformed ack timeout is refused at load, not at use', () => {
  const bad = [
    [{ notifications: { ackTimeout: 2 } }, 'a bare number'],
    [{ notifications: { ackTimeout: '2' } }, 'a string with no unit'],
    [{ notifications: { ackTimeout: 'soon' } }, 'not a duration'],
    [{ notifications: '2s' }, 'not an object'],
    [{ notifications: { ackTimeout: '2s', retries: 3 } }, 'an unknown nested key'],
  ]
  for (const [config, why] of bad) {
    assert.throws(() => validateServerConfigTopLevel(config, 'server.yaml'), undefined, `${why} should be refused`)
  }
  // Controls: the good shape passes, and the allow-list still rejects a genuinely
  // unknown top-level key rather than having been loosened.
  assert.doesNotThrow(() => validateServerConfigTopLevel({ notifications: { ackTimeout: '2s' } }, 'server.yaml'))
  assert.doesNotThrow(() => validateServerConfigTopLevel({ uploadDir: '/tmp/x' }, 'server.yaml'))
  assert.throws(() => validateServerConfigTopLevel({ bogusKey: 1 }, 'server.yaml'))
})
