import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const script = readFileSync(new URL('../scripts/fly-entrypoint-live.sh', import.meta.url), 'utf8')

function assertPersistedIdentityBootsWithoutSetupKey(source) {
  const tailscaled = source.indexOf('tailscaled \\\n')
  const keyBranch = source.indexOf('if [ -n "${TS_AUTHKEY:-}" ]; then')
  const optionalArg = source.indexOf('$AUTH_ARG --hostname=')

  assert.notEqual(tailscaled, -1, 'the persisted tailscaled identity starts')
  assert.notEqual(keyBranch, -1, 'the setup key is optional')
  assert.ok(tailscaled < keyBranch, 'tailscaled startup is not gated on a setup key')
  assert.notEqual(optionalArg, -1, 'tailscale up receives the optional auth argument')
  assert.doesNotMatch(source, /if \[ -n "\$TS_AUTHKEY" \]; then[\s\S]{0,300}tailscaled/)
}

test('live deploy restarts from persisted Tailscale identity without TS_AUTHKEY', () => {
  assertPersistedIdentityBootsWithoutSetupKey(script)
})

test('the guard rejects the outage shape from the previous entrypoint', () => {
  const regressed = script.replace(
    'mkdir -p "$PERSIST/tailscale" /var/run/tailscale\ntailscaled \\\n',
    'if [ -n "$TS_AUTHKEY" ]; then\n  mkdir -p "$PERSIST/tailscale" /var/run/tailscale\n  tailscaled \\\n',
  )
  assert.throws(() => assertPersistedIdentityBootsWithoutSetupKey(regressed))
})
