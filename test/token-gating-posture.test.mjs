// The posture of every deployment must be readable from its config file.
//
// This used to be false in two directions. `authDisabled` was negatively named,
// so the safe state was a double negative; and the only token-gated deployment
// (overleaf-test, on the public internet) expressed that by *not mentioning*
// gating at all, while the four open tailnet boxes each said `authDisabled: true`.
// The gated box was the silent one. Flipping to a positive default-false option
// would have silently ungated it, which is what these tests exist to catch.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const DEPLOYMENTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'deployments')

// Deliberately a line match rather than a YAML parse: the claim is about what a
// human reads in the file, which is the whole point of the change.
function gatingLine(name) {
  const text = readFileSync(join(DEPLOYMENTS, name, 'server.yaml'), 'utf8')
  const line = text.split('\n').find(l => /^\s*tokenGating\s*:/.test(l))
  return line ? line.trim() : null
}

const deployments = readdirSync(DEPLOYMENTS, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .map(e => e.name)

test('no deployment still uses the negatively-named key', () => {
  for (const name of deployments) {
    const text = readFileSync(join(DEPLOYMENTS, name, 'server.yaml'), 'utf8')
    assert.ok(
      !/^\s*authDisabled\s*:/m.test(text),
      `${name}/server.yaml still sets authDisabled; the option is tokenGating and it defaults false`,
    )
  }
})

test('the public-internet deployment states its gating explicitly', () => {
  // overleaf-test is reachable off the tailnet. Under a default-false option,
  // saying nothing means ungated — so it has to say something.
  assert.equal(gatingLine('overleaf-test'), 'tokenGating: true')
})

test('the tailnet deployments leave gating off by omission', () => {
  for (const name of ['live', 'stable', 'rc', 'talk']) {
    assert.equal(
      gatingLine(name),
      null,
      `${name} should not set tokenGating — it defaults false, and the tailnet is the boundary`,
    )
  }
})

test('gating is off unless a config file turns it on', async () => {
  const { initAuth, isTokenGatingEnabled, validateToken } = await import('../server/lib/auth.mjs')
  // No PORT escape hatch any more: the posture comes from config, and only config.
  // A worktree server on a non-standard port used to answer differently here.
  const previousPort = process.env.PORT
  process.env.PORT = '39999'
  try {
    initAuth()
    assert.equal(isTokenGatingEnabled(), false)
    // Ungated means every caller is already 'rw'; nothing is silently half-open.
    assert.equal(validateToken(null), 'rw')
    assert.equal(validateToken('anything'), 'rw')
  } finally {
    if (previousPort == null) delete process.env.PORT
    else process.env.PORT = previousPort
  }
})
