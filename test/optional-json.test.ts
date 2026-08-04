import assert from 'node:assert/strict'
import test from 'node:test'

import { optionalJson } from '../src/optionalJson'

test('optional JSON treats 204 as absent without parsing its empty body', async () => {
  assert.equal(await optionalJson(new Response(null, { status: 204 })), null)
})

test('optional JSON parses a present successful response', async () => {
  assert.deepEqual(await optionalJson(Response.json({ ok: true })), { ok: true })
})
