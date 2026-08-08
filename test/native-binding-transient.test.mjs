import assert from 'node:assert/strict'
import test from 'node:test'

// The unit under test is STATUS-CODE HANDLING, so `fetch` is stubbed rather
// than a server stood up: the fleet server URL is resolved from config, not an
// env var, and the branch being exercised never inspects the body.
let respond = () => ({ status: 404 })
let hits = 0
globalThis.fetch = async (url) => {
  hits++
  const { status, body } = respond(hits, String(url))
  return { status, ok: status >= 200 && status < 300, json: async () => body ?? {} }
}
process.env.FLEET_ID = 'fleet:parent01'

const { nativeChildBinding } = await import('../mcp-server/fleet-tools.mjs')
const call = () => nativeChildBinding('thread-not-mine-abc', null, {})

test('404 means NO binding — null, so the caller keeps its own identity', async () => {
  hits = 0; respond = () => ({ status: 404 })
  assert.equal(await call(), null)
})

test('a transient 502 no longer aborts the tool — it retries and succeeds', async () => {
  hits = 0
  respond = n => n === 1 ? { status: 502 } : { status: 200, body: { child_agent_id: 'fleet:child9' } }
  assert.equal((await call()).child_agent_id, 'fleet:child9')
  assert.ok(hits >= 2, `expected a retry, saw ${hits} call(s)`)
})

test('a transient 409 (no daemon route) retries instead of killing the call', async () => {
  hits = 0
  respond = n => n === 1 ? { status: 409 } : { status: 404 }
  assert.equal(await call(), null)
  assert.ok(hits >= 2)
})

test('a thrown fetch (socket/abort) is treated as unknown, not as no-binding', async () => {
  hits = 0
  globalThis.fetch = async () => { hits++; throw new Error('socket hang up') }
  await assert.rejects(call(), /socket hang up/)
  globalThis.fetch = async (url) => { hits++; const r = respond(hits, String(url)); return { status: r.status, ok: r.status < 300, json: async () => r.body ?? {} } }
})

// Counterfactuals — it must still fail, and must never guess.
test('a persistent 502 THROWS — it never guesses null and misattributes writes', async () => {
  hits = 0; respond = () => ({ status: 502 })
  await assert.rejects(call(), /HTTP 502/)
})

test('a permanently routeless agent (409 forever) throws, carrying the status', async () => {
  hits = 0; respond = () => ({ status: 409 })
  await assert.rejects(call(), /HTTP 409/)
})

test('a good binding is returned unchanged, with no retry', async () => {
  hits = 0; respond = () => ({ status: 200, body: { child_agent_id: 'fleet:child1', harness: 'claude' } })
  assert.equal((await call()).child_agent_id, 'fleet:child1')
  assert.equal(hits, 1)
})
