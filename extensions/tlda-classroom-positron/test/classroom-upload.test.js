const assert = require('node:assert/strict')
const test = require('node:test')
const { ClassroomUploadError, classroomSubmissionMetadata, submitSubmissionArchive } = require('../src/classroom-upload')

test('reads public server and assignment coordinates from QMD front matter', () => {
  const metadata = classroomSubmissionMetadata(`---
title: Getting Set Up
tlda-classroom-server: "https://class.example/ignored/path"
tlda-classroom-assignment: 'hw-minus-1-setup'
---
`)
  assert.deepEqual(metadata, { server: 'https://class.example', assignmentId: 'hw-minus-1-setup' })
  assert.equal(classroomSubmissionMetadata('---\ntitle: Notes\n---\n'), null)
})

test('uploads the archive with only the student credential and returns the receipt', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  let seen
  const receipt = await submitSubmissionArchive({
    server: 'https://class.example', assignmentId: 'hw minus 1', classroomToken: 'student-secret', archiveBytes: bytes,
    fetchImpl: async (url, init) => {
      seen = { url: url.toString(), init }
      return new Response(JSON.stringify({ submittedAt: '2026-08-28T12:00:00Z' }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  assert.equal(seen.url, 'https://class.example/api/classroom/assignments/hw%20minus%201/mine/upload')
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.headers['content-type'], 'application/zip')
  assert.equal(seen.init.headers['x-tlda-student-token'], 'student-secret')
  assert.equal(seen.init.headers.authorization, undefined)
  assert.strictEqual(seen.init.body, bytes)
  assert.equal(receipt.submittedAt, '2026-08-28T12:00:00Z')
})

test('reports a rejected credential without echoing it', async () => {
  await assert.rejects(
    submitSubmissionArchive({
      server: 'https://class.example', assignmentId: 'hw-minus-1-setup', classroomToken: 'do-not-print-me', archiveBytes: new Uint8Array(),
      fetchImpl: async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }),
    }),
    error => error instanceof ClassroomUploadError && error.status === 401 && !error.message.includes('do-not-print-me')
  )
})
