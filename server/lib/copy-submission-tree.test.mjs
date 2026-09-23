import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { copySubmissionTree } from './copy-submission-tree.mjs'

test('copy submission tree refuses a store with no live source configured', async () => {
  await assert.rejects(
    copySubmissionTree({ project: 'submission-hw1-alice', liveStoreUrl: '', replaceFiles() {} }),
    error => error.status === 409 && /not configured/.test(error.message),
  )
})

test('copy submission tree reports the live store refusal and does not replace preview', async () => {
  let replaced = false
  await assert.rejects(
    copySubmissionTree({
      project: 'submission-hw1-alice',
      liveStoreUrl: 'http://live.internal:5176',
      token: 'operator',
      fetchImpl: async (_url, init) => {
        assert.equal(init.headers.Authorization, 'Bearer operator')
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
      },
      replaceFiles() { replaced = true },
    }),
    /refused the file list with 401:.*Unauthorized/,
  )
  assert.equal(replaced, false)
})

test('copy submission tree refuses a malformed live batch and does not replace preview', async () => {
  let replaced = false
  await assert.rejects(
    copySubmissionTree({
      project: 'submission-hw1-alice',
      liveStoreUrl: 'http://live.internal:5176',
      fetchImpl: async (url) => {
        if (String(url).includes('/files')) return Response.json({ files: ['photo.png'] })
        return new Response('not-json{{{', { status: 200 })
      },
      replaceFiles() { replaced = true },
    }),
    /unreadable source batch/,
  )
  assert.equal(replaced, false)
})

test('copy submission tree round-trips photo bytes and replaces once', async () => {
  const photo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
  const replacements = []
  const result = await copySubmissionTree({
    project: 'submission-hw1-alice',
    liveStoreUrl: 'http://live.internal:5176/',
    token: 'operator',
    fetchImpl: async (url, init) => {
      const href = String(url)
      assert.equal(init.headers.Authorization, 'Bearer operator')
      if (href.includes('/files')) return Response.json({ files: ['essay.qmd', 'photo.png'] })
      const batchUrl = new URL(href)
      assert.deepEqual(JSON.parse(batchUrl.searchParams.get('paths')), ['essay.qmd', 'photo.png'])
      return Response.json({
        revision: 'abc123',
        files: {
          'essay.qmd': Buffer.from('# hi\n').toString('base64'),
          'photo.png': photo.toString('base64'),
        },
      })
    },
    replaceFiles(files) { replacements.push(files) },
  })
  assert.deepEqual(result, { files: 2, source: 'http://live.internal:5176' })
  assert.equal(replacements.length, 1)
  assert.deepEqual(replacements[0].map(file => file.path), ['essay.qmd', 'photo.png'])
  assert.ok(Buffer.isBuffer(replacements[0][1].content))
  assert.ok(replacements[0][1].content.equals(photo))
})

test('copy submission tree has no scheduler or background caller', () => {
  const route = readFileSync(new URL('../routes/projects.mjs', import.meta.url), 'utf8')
  const calls = [...route.matchAll(/copySubmissionTree\s*\(/g)]
  assert.equal(calls.length, 1)
  assert.doesNotMatch(route, /setInterval\([^)]*copySubmissionTree|setTimeout\([^)]*copySubmissionTree|\.watch\([^)]*copySubmissionTree/)
})
