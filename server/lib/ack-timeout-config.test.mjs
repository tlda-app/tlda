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
  }
})

// This asserts what is TRUE today rather than what ought to be, and it is
// deliberate. The declared value does NOT exceed the MCP's serial budget, so a
// fully successful delivery cannot acknowledge in time — see the comment beside
// `WAKE_MCP_ACK_DEADLINE_DEFAULT`. Asserting the constraint instead would be
// asserting a property the system does not have, and a red suite is not a way to
// record an open question.
//
// So the degenerate relationship is PINNED. Changing the number turns this red,
// which is the point: it makes the change deliberate and sends whoever made it
// to `docs/notifications-and-liveness.md` §"What is not settled" item 1, where
// the number is Skip's to choose. Delete this test in the commit that settles it.
test('the declared ack timeout is still the known-degenerate value', () => {
  for (const env of DEPLOYMENTS) {
    const config = YAML.parse(readFileSync(join(repoRoot, 'config', 'deployments', env, 'server.yaml'), 'utf8'))
    const ms = parseDurationMs(config?.notifications?.ackTimeout)
    assert.ok(
      ms <= MCP_SERIAL_BUDGET_MS,
      `${env}: ackTimeout is now ${ms}ms, above the MCP's serial notice budget (${MCP_SERIAL_BUDGET_MS}ms). ` +
      'That may well be right — it is the open question in "What is not settled" item 1 — but it is Skip\'s call, ' +
      'and raising it is not free: the largest single source of these timeouts is a bot with no acknowledge path, ' +
      'for which a longer deadline only means waiting longer to reach the same outcome. ' +
      'If he has settled it, delete this test in the same commit.',
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

import { validateServerConfigTopLevel } from '../../shared/daemon-config-schema.mjs'

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
