#!/usr/bin/env node
// Recording audio must stream, and must honour Range.
//
// Both audio routes used to `readFileSync(audioPath)` then `.send(buf)` with
// `Accept-Ranges: none`, against a 500mb upload limit. That is a synchronous
// read of an entire lecture on the event loop: one student opening one
// recording blocks every other request, every socket message and every daemon
// RPC for the length of that read. Same shape as the 809ms edit-log stall, on a
// much bigger file.
//
// This drives a real express router over a real HTTP connection, because the
// property is about what goes over the wire — a whole-file read that happens to
// produce correct bytes would pass any test that only checked the body.
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = async (label, fn) => {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (e) {
    failures++
    console.error(`  FAIL ${label}: ${e.message}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'tlda-audio-stream-'))
const AUDIO = Buffer.alloc(3 * 1024 * 1024)
for (let i = 0; i < AUDIO.length; i++) AUDIO[i] = i % 251

let server
try {
  mkdirSync(join(dir, 'publication'), { recursive: true })
  writeFileSync(join(dir, 'rec1.json'), JSON.stringify({ id: 'rec1', audioMime: 'audio/webm;codecs=opus' }))
  writeFileSync(join(dir, 'publication', 'rec1.audio'), AUDIO)

  // The REAL handler, imported — not a copy of it. A replica of the handler
  // would test express's sendFile and prove nothing about this route.
  const { sendRecordingAudio } = await import('../server/routes/projects.mjs')
  const app = express()
  app.get('/audio', (req, res) =>
    sendRecordingAudio(res, join(dir, 'publication', 'rec1.audio'), join(dir, 'rec1.json')))
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}/audio`

  await check('serves the whole file when asked for it', async () => {
    const r = await fetch(base)
    assert.equal(r.status, 200)
    const body = Buffer.from(await r.arrayBuffer())
    assert.equal(body.length, AUDIO.length)
    assert.ok(body.equals(AUDIO), 'bytes must be unchanged')
  })

  await check('advertises range support — this is what Accept-Ranges: none denied', async () => {
    const r = await fetch(base)
    assert.equal(r.headers.get('accept-ranges'), 'bytes')
  })

  await check('a Range request returns 206 and ONLY those bytes', async () => {
    const r = await fetch(base, { headers: { Range: 'bytes=1048576-1048675' } })
    assert.equal(r.status, 206, 'a seek must be a partial response')
    const body = Buffer.from(await r.arrayBuffer())
    assert.equal(body.length, 100, 'a seek must not transfer the whole lecture')
    assert.ok(body.equals(AUDIO.subarray(1048576, 1048676)), 'and must be the right bytes')
    assert.match(r.headers.get('content-range') || '', /^bytes 1048576-1048675\/3145728$/)
  })

  await check('a suffix range works — the case hand-rolled parsers get wrong', async () => {
    const r = await fetch(base, { headers: { Range: 'bytes=-50' } })
    assert.equal(r.status, 206)
    const body = Buffer.from(await r.arrayBuffer())
    assert.equal(body.length, 50)
    assert.ok(body.equals(AUDIO.subarray(AUDIO.length - 50)))
  })

  await check('an unsatisfiable range is 416, not a truncated 200', async () => {
    const r = await fetch(base, { headers: { Range: `bytes=${AUDIO.length + 10}-${AUDIO.length + 20}` } })
    assert.equal(r.status, 416)
  })

  await check('the declared mime survives', async () => {
    const r = await fetch(base)
    assert.match(r.headers.get('content-type') || '', /audio\/webm/)
  })
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? 'PASS recording audio streams' : `FAIL recording audio streams (${failures})`)
process.exit(failures === 0 ? 0 : 1)
