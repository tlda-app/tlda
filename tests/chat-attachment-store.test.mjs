import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { copyAttachmentsToUploadDir } from '../server/lib/chat-attachment-store.mjs'

// Regression: chat attachment copies must land in the persistent upload dir (the
// same one /api/upload uses via TLDA_UPLOAD_DIR), NOT an ephemeral container path
// that Fly wipes on redeploy. Pre-fix the copy target was
// path.join(import.meta.dirname, 'uploads') = /app/server/uploads (wiped on deploy).

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('copies an existing attachment into the given upload dir and rewrites path', () => {
  const uploadDir = mkTmp('tlda-attach-dir-')
  const srcDir = mkTmp('tlda-attach-src-')
  const src = path.join(srcDir, 'shot.png')
  fs.writeFileSync(src, Buffer.from([1, 2, 3, 4]))

  const out = copyAttachmentsToUploadDir([{ token: '«x»', path: src }], uploadDir)
  assert.equal(out.length, 1)
  // path rewritten into the persistent upload dir; original preserved
  assert.ok(out[0].path.startsWith(uploadDir + path.sep), `dest must be inside uploadDir; got ${out[0].path}`)
  assert.equal(out[0].originalPath, src)
  assert.equal(out[0].token, '«x»')
  // bytes actually copied
  assert.ok(fs.existsSync(out[0].path))
  assert.ok(fs.readFileSync(out[0].path).equals(Buffer.from([1, 2, 3, 4])))

  fs.rmSync(uploadDir, { recursive: true, force: true })
  fs.rmSync(srcDir, { recursive: true, force: true })
})

test('leaves a missing-file attachment unchanged (no copy, no path rewrite)', () => {
  const uploadDir = mkTmp('tlda-attach-dir-')
  const att = { token: '«y»', path: '/no/such/file-xyz.png' }
  const out = copyAttachmentsToUploadDir([att], uploadDir)
  assert.deepEqual(out[0], att)
  assert.equal(fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).length : 0, 0)
  fs.rmSync(uploadDir, { recursive: true, force: true })
})

test('returns empty / null attachment lists unchanged', () => {
  assert.equal(copyAttachmentsToUploadDir(undefined, '/tmp/x'), undefined)
  assert.deepEqual(copyAttachmentsToUploadDir([], '/tmp/x'), [])
})

test('RESOLVED_UPLOAD_DIR (the copy target) honors TLDA_UPLOAD_DIR — persistent volume on Fly', async () => {
  const prev = process.env.TLDA_UPLOAD_DIR
  process.env.TLDA_UPLOAD_DIR = '/app/server/persist/uploads'
  try {
    // Fresh module load so the module-level const reads the env we just set.
    const mod = await import('../server/routes/fleet.mjs?persist-parity=1')
    assert.equal(mod.RESOLVED_UPLOAD_DIR, path.resolve('/app/server/persist/uploads'))
  } finally {
    if (prev == null) delete process.env.TLDA_UPLOAD_DIR
    else process.env.TLDA_UPLOAD_DIR = prev
  }
})
