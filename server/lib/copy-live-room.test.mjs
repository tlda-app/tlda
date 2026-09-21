import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { copyLiveRoomSnapshot } from './copy-live-room.mjs'

test('copy live data refuses a store with no live source configured', async () => {
  await assert.rejects(
    copyLiveRoomSnapshot({ project: 'book', liveStoreUrl: '', replaceSnapshot() {} }),
    error => error.status === 409 && /not configured/.test(error.message),
  )
})

test('copy live data reports the live store refusal and does not replace preview', async () => {
  let replaced = false
  await assert.rejects(
    copyLiveRoomSnapshot({
      project: 'book',
      liveStoreUrl: 'http://live.internal:5176',
      token: 'operator',
      fetchImpl: async (_url, init) => {
        assert.equal(init.headers.Authorization, 'Bearer operator')
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
      },
      replaceSnapshot() { replaced = true },
    }),
    /refused the room snapshot with 401:.*Unauthorized/,
  )
  assert.equal(replaced, false)
})

test('copy live data refuses malformed live state and does not replace preview', async () => {
  let replaced = false
  await assert.rejects(
    copyLiveRoomSnapshot({
      project: 'book',
      liveStoreUrl: 'http://live.internal:5176',
      fetchImpl: async () => Response.json({ shapes: [] }),
      replaceSnapshot() { replaced = true },
    }),
    /invalid room snapshot/,
  )
  assert.equal(replaced, false)
})

test('copy live data replaces the preview room once with the live snapshot', async () => {
  const snapshot = {
    documents: [
      { state: { id: 'shape:live', typeName: 'shape', type: 'note' } },
      { state: { id: 'page:page', typeName: 'page', name: 'Page 1' } },
    ],
  }
  const replacements = []
  const result = await copyLiveRoomSnapshot({
    project: 'qtm285-book',
    liveStoreUrl: 'http://live.internal:5176/',
    token: 'operator',
    fetchImpl: async (url) => {
      assert.equal(url.href, 'http://live.internal:5176/api/projects/qtm285-book/snapshot')
      return Response.json(snapshot)
    },
    replaceSnapshot(value) { replacements.push(value) },
  })

  assert.deepEqual(result, { shapes: 1, source: 'http://live.internal:5176' })
  assert.deepEqual(replacements, [snapshot])
})

test('copy live data has no scheduler or background caller', () => {
  const route = readFileSync(new URL('../routes/projects.mjs', import.meta.url), 'utf8')
  const calls = [...route.matchAll(/copyLiveRoomSnapshot\s*\(/g)]
  assert.equal(calls.length, 1)
  const handler = route.slice(route.lastIndexOf("router.post('/:name/copy-live'", calls[0].index), calls[0].index)
  assert.match(handler, /router\.post\('\/:name\/copy-live'/)
  assert.doesNotMatch(route, /setInterval\([^)]*copyLiveRoomSnapshot|setTimeout\([^)]*copyLiveRoomSnapshot|\.watch\([^)]*copyLiveRoomSnapshot/)
})
