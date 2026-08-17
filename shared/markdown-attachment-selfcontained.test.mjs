// A markdown file shared as an attachment used to be uploaded byte-for-byte, so
// the copy on the server still pointed at the SENDER's local paths. The message
// body it arrived with had its refs rewritten (bundleSharedMarkdownImages); the
// file did not. Anything later reading the uploaded file found refs nothing could
// resolve — and the server cannot resolve them on the reader's behalf either,
// because they name a file on another machine and /api/file is confined to the
// upload directory by design.
//
// The case that surfaced it: dragging a markdown chip onto the canvas appended
// "⚠️ Some embedded images couldn't be resolved" and dropped the images.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { uploadAttachments } from './message-processing.mjs'

// Stands in for the fleet server's POST /api/upload. Records what bytes were
// uploaded under what name, which is the whole point: the assertion is about the
// CONTENT that goes up, not about the request succeeding.
function installUploadCapture() {
  const uploaded = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const name = decodeURIComponent(opts.headers?.['x-filename'] || 'unnamed')
    const body = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body || '')
    uploaded.push({ name, body })
    return {
      ok: true,
      json: async () => ({ url: `/api/file?path=/uploads/${uploaded.length}-${name}` }),
    }
  }
  return { uploaded, restore: () => { globalThis.fetch = realFetch } }
}

test('a shared markdown is uploaded with its image refs rewritten, and the image uploaded too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-md-selfcontained-'))
  const { uploaded, restore } = installUploadCapture()
  try {
    const imgPath = join(dir, 'plot.png')
    writeFileSync(imgPath, Buffer.from('fake-png-bytes'))
    const mdPath = join(dir, 'note.md')
    writeFileSync(mdPath, `# Note\n\n![a plot](${imgPath})\n\nSee also ![rel](plot.png).\n`)

    const attachments = [{ type: 'file', id: 0, path: mdPath, name: 'note.md' }]
    await uploadAttachments(attachments, 'https://fleet.example')

    const md = uploaded.find(u => u.name === 'note.md')
    assert.ok(md, 'the markdown itself was uploaded')
    const text = md.body.toString('utf8')

    // The point of the change: the bytes on the server no longer name the
    // sender's filesystem.
    // The point of the change: the bytes on the server no longer name the
    // sender's filesystem. URLs are absolute against the fleet origin so they
    // resolve identically from a phone, an iPad, or a laptop.
    assert.ok(!text.includes(imgPath), `uploaded markdown still contains the sender path:\n${text}`)
    assert.match(text, /!\[a plot\]\(https:\/\/fleet\.example\/api\/file\?path=/, 'absolute ref now points at an uploaded URL')
    assert.match(text, /!\[rel\]\(https:\/\/fleet\.example\/api\/file\?path=/, 'relative ref rewritten too')

    // The image has to travel, or the rewritten URL would 404.
    assert.ok(uploaded.some(u => u.name === 'plot.png'), 'the referenced image was uploaded')

    // 2, not 1, and that is pre-existing behaviour rather than something this
    // change introduced: scanMarkdownDeps dedupes by REF STRING, so the same
    // file referenced both absolutely and relatively counts twice and uploads
    // twice. Both URLs work, so it is waste and not breakage. Asserted at 2 so
    // that if anyone tightens the dedup to be by resolved path, this test tells
    // them it changed rather than passing silently.
    assert.equal(attachments[0].depsUploaded, 2, 'both refs counted (dedup is by ref string, not by file)')
    assert.equal(attachments[0].depsMissing, undefined, 'nothing missing')

    // Metadata must describe what was uploaded, not the on-disk original.
    assert.equal(attachments[0].size, md.body.length, 'size matches the uploaded bytes')
    assert.notEqual(md.body.length, readFileSync(mdPath).length, 'uploaded bytes differ from disk')
  } finally {
    restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a markdown with a missing dep still uploads and reports the miss', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-md-selfcontained-missing-'))
  const { uploaded, restore } = installUploadCapture()
  try {
    const mdPath = join(dir, 'broken.md')
    writeFileSync(mdPath, `![gone](${join(dir, 'nope.png')})\n`)

    const attachments = [{ type: 'file', id: 0, path: mdPath, name: 'broken.md' }]
    await uploadAttachments(attachments, 'https://fleet.example')

    // A broken ref must not fail the share — the file is still worth sending.
    assert.ok(uploaded.find(u => u.name === 'broken.md'), 'still uploaded')
    assert.ok(attachments[0].url, 'still got a url')
    assert.equal(attachments[0].broken, undefined, 'the attachment itself is not broken')
    assert.deepEqual(attachments[0].depsMissing?.length, 1, 'the missing dep is reported')
  } finally {
    restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a non-markdown attachment is uploaded unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-md-selfcontained-plain-'))
  const { uploaded, restore } = installUploadCapture()
  try {
    const p = join(dir, 'data.csv')
    const bytes = Buffer.from('a,b\n1,2\n')
    writeFileSync(p, bytes)

    const attachments = [{ type: 'file', id: 0, path: p, name: 'data.csv' }]
    await uploadAttachments(attachments, 'https://fleet.example')

    assert.equal(uploaded.length, 1, 'no extra uploads for a non-markdown file')
    assert.deepEqual(uploaded[0].body, bytes, 'bytes untouched')
    assert.equal(attachments[0].depsUploaded, undefined, 'no dep bookkeeping')
  } finally {
    restore()
    rmSync(dir, { recursive: true, force: true })
  }
})
