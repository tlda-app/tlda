import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { classroomWebManifest } from './classroom.mjs'

const manifest = classroomWebManifest({ course: { id: 'pic', title: 'PIC' }, project: 'fixture', readToken: 'read' })
assert.deepEqual(manifest.icons, [{ src: '/tlda-mark.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }])
for (const deployment of ['pic', 'pic-dev']) {
  const bytes = await readFile(new URL(`../../config/deployments/${deployment}/dist-overrides/tlda-mark.svg`, import.meta.url))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '323ad80d4ee25abb4f5660af7e7d07b7fa9769295ba9b8afaa67700c590668ad')
  const artwork = bytes.toString('utf8')
  assert.match(artwork, /<circle cx="32" cy="15"/)
  assert.match(artwork, /translate\(32,15\)/)
  assert.match(artwork, /translate\(14,48\)/)
  assert.match(artwork, /translate\(50,48\)/)
}
console.log('classroom manifest PIC icon bytes: PASS')
