import { strict as assert } from 'node:assert'
import { Readable } from 'node:stream'
import test from 'node:test'
import { gzipSync, deflateSync } from 'node:zlib'

import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGitHttpHandler, decodedRequestStream } from './git-http.mjs'

const WANT = '0032want 76770cdd8392f431e4ef6021c134de5e61f1bba0\n0000'

function request(body, headers = {}) {
  const stream = Readable.from([body])
  stream.headers = headers
  return stream
}

async function read(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

test('a gzip upload-pack request reaches git decompressed', async () => {
  // What git actually sends for a fetch. Piping this raw gave upload-pack gzip
  // bytes, which is the 500.
  const req = request(gzipSync(Buffer.from(WANT)), { 'content-encoding': 'gzip' })
  assert.equal(await read(decodedRequestStream(req)), WANT)
})

test('x-gzip and deflate are decoded too', async () => {
  assert.equal(
    await read(decodedRequestStream(request(gzipSync(Buffer.from(WANT)), { 'content-encoding': 'x-gzip' }))),
    WANT,
  )
  assert.equal(
    await read(decodedRequestStream(request(deflateSync(Buffer.from(WANT)), { 'content-encoding': 'deflate' }))),
    WANT,
  )
})

test('an unencoded request is passed through untouched', async () => {
  // receive-pack — git does not compress it, and it has always worked.
  const req = request(Buffer.from(WANT), {})
  assert.equal(decodedRequestStream(req), req)
  assert.equal(await read(req), WANT)
})

test('an unknown encoding is not silently mangled', async () => {
  const req = request(Buffer.from(WANT), { 'content-encoding': 'identity' })
  assert.equal(decodedRequestStream(req), req)
  assert.equal(await read(req), WANT)
})

// A body that is not the encoding it claims. Unhandled, the decoder's `error`
// ends the process — eight bad bytes would stop the server.
test('malformed gzip surfaces an error instead of throwing', async () => {
  const req = request(Buffer.from('not gzip'), { 'content-encoding': 'gzip' })
  const stream = decodedRequestStream(req)
  const error = await new Promise(resolve => {
    stream.on('error', resolve)
    stream.resume()
  })
  assert.match(String(error.code || error.message), /Z_DATA_ERROR|incorrect header/i)
})

test('truncated gzip surfaces an error instead of throwing', async () => {
  const whole = gzipSync(Buffer.from(WANT))
  const req = request(whole.subarray(0, Math.floor(whole.length / 2)), { 'content-encoding': 'gzip' })
  const stream = decodedRequestStream(req)
  const error = await new Promise(resolve => {
    stream.on('error', resolve)
    stream.resume()
  })
  assert.ok(error, 'truncated gzip must report an error')
})

// The stream tests above prove the decoder reports rather than throws. This one
// proves the handler turns that report into the ordinary HTTP failure and stays
// up: if the error were unhandled the process would die and this test could not
// finish at all.
test('a malformed body is answered 500 and the server survives', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-git-http-encoding-'))
  const gitDir = join(root, 'repo.git')
  execFileSync('git', ['init', '--bare', '-q', gitDir])
  const handler = createGitHttpHandler({
    validateToken: () => 'rw',
    repositoryForProject: async () => ({ gitDir }),
    admitProposal: async () => {},
  })
  const server = createServer((req, res) => {
    res.status = code => { res.statusCode = code; return res }
    handler(req, res, () => { res.statusCode = 404; res.end() })
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const auth = Buffer.from('mini-testing:token').toString('base64')
    const post = body => fetch(`http://127.0.0.1:${port}/git/paper/git-upload-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-encoding': 'gzip' },
      body,
    })

    const bad = await post(Buffer.from('not gzip'))
    assert.equal(bad.status, 500)
    // The body failure is what settled the call. The killed child closes
    // afterwards and must not overwrite it — that is the once-only resolver
    // doing its job, observable rather than asserted by reading.
    assert.match(await bad.text(), /request body:/)

    const truncated = gzipSync(Buffer.from(WANT))
    const cut = await post(truncated.subarray(0, Math.floor(truncated.length / 2)))
    assert.equal(cut.status, 500)

    // Still serving after both — the point of the test.
    const alive = await post(Buffer.from('not gzip'))
    assert.equal(alive.status, 500)
  } finally {
    await new Promise(resolve => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})
