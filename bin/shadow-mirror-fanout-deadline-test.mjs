#!/usr/bin/env node
// One unreachable daemon must not hang every build.
//
// The mirror fans out to every connected daemon and waits for all of them, using
// the durable sender — chosen deliberately to retry a WS flap rather than throw a
// short timeout. With no per-key deadline that combination is unbounded: a key
// that never answers never settles, the mirror never returns, the build worker
// awaiting it never exits, `_inFlight` never releases, and every later dispatch is
// answered `already-building` → `superseded`.
//
// On 2026-08-17 that held Skip's render five hours stale and survived killing the
// worker, restarting the daemon, and restarting the server — because none of those
// touch the thing doing the waiting.
import assert from 'node:assert/strict'
import { createShadowMirrorRpcHandler } from '../server/lib/shadow-mirror-rpc.mjs'

const readProject = async () => ({ lastSourceMachineId: 'mini', lastSourceEnvName: 'testing' })
const mirrorArgs = {
  name: 'paper',
  hash: 'a'.repeat(40),
  bundleBase64: 'YnVuZGxl',
  sourceScope: ['main.tex'],
  sourceRevision: 'sha256:abc',
  acceptSeq: 1,
}

// One daemon answers; the other never will. This is the live shape: a stale key in
// `daemonConnections` that no longer has a process behind it.
let liveCalls = 0
const neverAnswers = () => new Promise(() => {})
const handler = createShadowMirrorRpcHandler({
  readProject,
  listDaemonKeys: () => ['mini:testing', 'ghost:testing'],
  daemonAddressFor: (machineId, envName) => `${machineId}:${envName}`,
  keyTimeoutMs: 150,
  sendDaemonEphemeral: async (key) => {
    if (key === 'ghost:testing') return neverAnswers()
    liveCalls++
    return { ok: true, machine_id: 'mini', env_name: 'testing' }
  },
})

const started = Date.now()
const result = await handler(mirrorArgs)
const elapsed = Date.now() - started

// The whole point: it returns at all.
assert.ok(elapsed < 5000, `fan-out settled in ${elapsed}ms rather than hanging`)
assert.ok(elapsed >= 150, 'it waited for the deadline rather than skipping the slow key')

assert.equal(liveCalls, 1, 'the reachable daemon was still offered the mirror')
assert.equal(result.ok, true, 'a mirror that one daemon accepted is a success')
// `mirrored` is a list of key strings; `declined` is `{ key, reason }`.
assert.deepEqual(result.mirrored, ['mini:testing'], 'the live daemon mirrored')
assert.deepEqual(result.declined.map(d => d.key), ['ghost:testing'], 'the silent daemon is a decline, not a hang')
assert.match(result.declined[0].reason, /did not answer the mirror/, 'the decline says why')

// And the existing contract is unchanged: if NO daemon takes it, that is still a
// failure rather than a quiet success. A timeout must not become a way to pass.
const allSilent = createShadowMirrorRpcHandler({
  readProject,
  listDaemonKeys: () => ['ghost-a:testing', 'ghost-b:testing'],
  daemonAddressFor: (machineId, envName) => `${machineId}:${envName}`,
  keyTimeoutMs: 150,
  sendDaemonEphemeral: neverAnswers,
})
await assert.rejects(
  () => allSilent(mirrorArgs),
  /no daemon accepted the mirror/,
  'every daemon timing out is still a failed mirror',
)

console.log('shadow mirror fan-out deadline: ok')
