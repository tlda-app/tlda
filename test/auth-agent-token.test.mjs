// TLDA_TOKEN_AGENT: the agents' own credential on a gated box.
//
// pic's server honors exactly the secrets in its environment. For one night
// agents had no credential of their own there: the Mini's operator token 401'd,
// and the only values pic accepted belonged to someone else. The agent token
// is a third value with the same operator admission, so it can be rotated and
// revoked without touching what the box already runs on.
//
// These run against a fixture config dir mirroring pic's posture
// (tokenGating + tokensFromEnvironmentOnly), with the module imported after
// TLDA_CONFIG_DIR points at the fixture — CONFIG_DIR freezes at import time.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const OPERATOR = { kind: 'operator', groups: [] }
const READ = 'test-pic-read-value'
const RW = 'test-pic-rw-value'
const AGENT = 'test-pic-agent-value'

const dir = mkdtempSync(join(tmpdir(), 'tlda-agent-token-'))
writeFileSync(join(dir, 'server.yaml'), 'tokenGating: true\ntokensFromEnvironmentOnly: true\n')
process.env.TLDA_CONFIG_DIR = dir
const auth = await import('../server/lib/auth.mjs')

test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setTokens({ read, rw, agent }) {
  for (const [key, value] of Object.entries({
    TLDA_TOKEN_READ: read,
    TLDA_TOKEN_RW: rw,
    TLDA_TOKEN_AGENT: agent,
  })) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
}

test('agent token is admitted alongside read and RW', () => {
  setTokens({ read: READ, rw: RW, agent: AGENT })
  auth.initAuth()
  assert.equal(auth.isTokenGatingEnabled(), true)
  assert.deepEqual(auth.resolveIdentity(READ), OPERATOR)
  assert.deepEqual(auth.resolveIdentity(RW), OPERATOR)
  assert.deepEqual(auth.resolveIdentity(AGENT), OPERATOR)
  assert.equal(auth.resolveIdentity('not-a-token'), null)
  assert.equal(auth.resolveIdentity(null), null)
})

test('agent token alone satisfies gating', () => {
  setTokens({ agent: AGENT })
  auth.initAuth()
  assert.equal(auth.isTokenGatingEnabled(), true)
  assert.deepEqual(auth.resolveIdentity(AGENT), OPERATOR)
  assert.equal(auth.resolveIdentity(RW), null)
})

test('no token at all still fails loudly', () => {
  setTokens({})
  assert.throws(() => auth.initAuth(), /TLDA_TOKEN_AGENT/)
})

test('an unset agent token changes nothing', () => {
  setTokens({ read: READ, rw: RW })
  auth.initAuth()
  assert.deepEqual(auth.resolveIdentity(READ), OPERATOR)
  assert.deepEqual(auth.resolveIdentity(RW), OPERATOR)
  assert.equal(auth.resolveIdentity(AGENT), null)
  assert.equal(auth.resolveIdentity('not-a-token'), null)
})

test('the agent token never becomes the link token', () => {
  setTokens({ agent: AGENT })
  auth.initAuth()
  assert.equal(auth.configuredReadToken(), null)
  setTokens({ read: READ, rw: RW, agent: AGENT })
  auth.initAuth()
  assert.equal(auth.configuredReadToken(), READ)
})
