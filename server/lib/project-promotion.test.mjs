import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdirSync, truncateSync } from 'node:fs'
import { constants as bufferConstants } from 'node:buffer'
import { Readable, Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSourceLifecycleStore } from './source-lifecycle.mjs'
import { closeProjectStore, createProject, initProjectStore, serializeProjectStoreOperation } from './project-store.mjs'
import { exportProjectPromotion, importProjectPromotion, importProjectPromotionStream, promotionArtifactHash, writeProjectPromotionStream } from './project-promotion.mjs'

async function fixture(format = 'html') {
  const root = mkdtempSync(join(tmpdir(), 'tlda-promotion-'))
  const source = join(root, 'source', 'course')
  const destination = join(root, 'destination')
  mkdirSync(join(source, 'output'), { recursive: true })
  mkdirSync(destination, { recursive: true })
  writeFileSync(join(source, 'project.json'), JSON.stringify({ name: 'course', title: 'Course', format, pages: 1, sourceDir: '/private/machine', room: 'no' }))
  writeFileSync(join(source, 'output', 'index.html'), '<h1>Course</h1>')
  writeFileSync(join(source, 'build.log'), 'built')
  const lifecycle = createSourceLifecycleStore({ root: join(source, '.source-lifecycle'), project: 'course' })
  const git = await lifecycle.gitRepository()
  const revision = await git.acceptRevision({ project: 'course', files: [{ path: 'index.qmd', content: '# Course' }] })
  await git.advanceHead('course', revision, null)
  lifecycle.recordRevisionAdmission('course', revision, 7)
  lifecycle.recordRevisionPhase('course', revision, 'build', 'built', { ok: true })
  const serialize = (_name, operation) => operation()
  const artifact = await exportProjectPromotion({ name: 'course', revision, sourceEnvironment: 'preview', projectRoot: source, lifecycleStore: lifecycle, serialize })
  return { root, source, destination, lifecycle, revision, artifact, serialize }
}

async function promotionStream(f) {
  const chunks = []
  const destination = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } })
  await writeProjectPromotionStream({ name: 'course', revision: f.revision, sourceEnvironment: 'preview', projectRoot: f.source, lifecycleStore: f.lifecycle, serialize: f.serialize, destination })
  return Buffer.concat(chunks)
}

function asWebStream(bytes) {
  return Readable.toWeb(Readable.from(bytes))
}

function headerBounds(bytes) {
  const magicLength = Buffer.byteLength('TLDA-PROMOTION-2\n')
  const length = bytes.readUInt32BE(magicLength)
  return { start: magicLength + 4, end: magicLength + 4 + length }
}

function replaceHeader(bytes, change) {
  const { start, end } = headerBounds(bytes)
  const header = JSON.parse(bytes.subarray(start, end))
  change(header)
  const encoded = Buffer.from(JSON.stringify(header))
  const length = Buffer.alloc(4)
  length.writeUInt32BE(encoded.length)
  return Buffer.concat([bytes.subarray(0, start - 4), length, encoded, bytes.subarray(end)])
}

async function importStream(f, bytes, overrides = {}) {
  return importProjectPromotionStream({ stream: asWebStream(bytes), sourceEnvironment: 'preview', name: 'course', revision: f.revision, projectsRoot: f.destination, serialize: f.serialize, ...overrides })
}

test('stream promotion activates exact output without aggregate JSON', async () => {
  const f = await fixture()
  try {
    const bytes = await promotionStream(f)
    const result = await importStream(f, bytes)
    assert.equal(result.promoted, true)
    assert.equal(readFileSync(join(f.destination, 'course', 'output', 'index.html'), 'utf8'), '<h1>Course</h1>')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('stream promotion refuses truncation, trailing data, and member corruption', async () => {
  for (const transform of [
    bytes => bytes.subarray(0, bytes.length - 1),
    bytes => Buffer.concat([bytes, Buffer.from('trailing')]),
    bytes => { const copy = Buffer.from(bytes); copy[copy.length - 1] ^= 1; return copy },
  ]) {
    const f = await fixture()
    try {
      await assert.rejects(importStream(f, transform(await promotionStream(f))))
      assert.equal(existsSync(join(f.destination, 'course')), false)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  }
})

test('stream promotion refuses traversal, duplicates, and size overruns', async () => {
  for (const [change, expected] of [
    [header => { header.members.find(row => row.kind === 'output').path = '../escape' }, /invalid project promotion path/],
    [header => { header.members.push({ ...header.members.find(row => row.kind === 'output') }) }, /duplicate project promotion member/],
    [header => { header.members.find(row => row.kind === 'output').size = 2 ** 31 + 1 }, /invalid project promotion member size/],
  ]) {
    const f = await fixture()
    try {
      await assert.rejects(importStream(f, replaceHeader(await promotionStream(f), change)), expected)
      assert.equal(existsSync(join(f.destination, 'course')), false)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  }
})

test('stream export refuses symlink members', async () => {
  const f = await fixture()
  try {
    symlinkSync('/tmp', join(f.source, 'output', 'outside'))
    const destination = new Writable({ write(_chunk, _encoding, callback) { callback() } })
    await assert.rejects(writeProjectPromotionStream({ name: 'course', revision: f.revision, sourceEnvironment: 'preview', projectRoot: f.source, lifecycleStore: f.lifecycle, serialize: f.serialize, destination }), /refuses symlink/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('source export settles and releases serialization on destination disconnect', async () => {
  const f = await fixture()
  try {
    let held = false
    const serialize = async (_name, operation) => {
      held = true
      try { return await operation() } finally { held = false }
    }
    let received = 0
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        received += chunk.length
        callback()
        if (received > 32) this.destroy()
      },
    })
    await assert.rejects(writeProjectPromotionStream({ name: 'course', revision: f.revision, sourceEnvironment: 'preview', projectRoot: f.source, lifecycleStore: f.lifecycle, serialize, destination }))
    assert.equal(held, false)
    assert.equal(readdirSync(f.source).some(name => name.startsWith('.promotion-')), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('destination rejection cancels the upstream promotion body', async () => {
  const f = await fixture()
  try {
    let canceled = false
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('not-a-promotion-stream')) },
      cancel() { canceled = true },
    })
    await assert.rejects(importProjectPromotionStream({ stream, sourceEnvironment: 'preview', name: 'course', revision: f.revision, projectsRoot: f.destination, serialize: f.serialize }), /invalid project promotion stream/)
    assert.equal(canceled, true)
    assert.equal(existsSync(join(f.destination, 'course')), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('stream export applies backpressure beyond the v1 string limit', async () => {
  const f = await fixture()
  try {
    const size = bufferConstants.MAX_STRING_LENGTH
    const large = join(f.source, 'output', 'large.bin')
    writeFileSync(large, '')
    truncateSync(large, size)
    let streamed = 0
    const destination = new Writable({ highWaterMark: 1024, write(chunk, _encoding, callback) { streamed += chunk.length; setImmediate(callback) } })
    await writeProjectPromotionStream({ name: 'course', revision: f.revision, sourceEnvironment: 'preview', projectRoot: f.source, lifecycleStore: f.lifecycle, serialize: f.serialize, destination })
    assert.ok(Math.ceil(size / 3) * 4 > bufferConstants.MAX_STRING_LENGTH)
    assert.ok(streamed > size)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('promotes the exact successful revision and rendering-only allowlist', async () => {
  const f = await fixture()
  try {
    const result = await importProjectPromotion({ artifact: f.artifact, sourceEnvironment: 'preview', name: 'course', revision: f.revision, projectsRoot: f.destination, serialize: f.serialize })
    assert.equal(result.promoted, true)
    assert.equal(readFileSync(join(f.destination, 'course', 'output', 'index.html'), 'utf8'), '<h1>Course</h1>')
    const metadata = JSON.parse(readFileSync(join(f.destination, 'course', 'project.json'), 'utf8'))
    assert.equal(metadata.sourceDir, undefined)
    assert.equal(metadata.room, undefined)
    assert.equal(await (await createSourceLifecycleStore({ root: join(f.destination, 'course', '.source-lifecycle'), project: 'course' }).gitRepository()).head('course'), f.revision)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('materializes accepted source only for QMD promotion', async () => {
  for (const format of ['qmd', 'html']) {
    const f = await fixture(format)
    try {
      await importProjectPromotion({ artifact: f.artifact, sourceEnvironment: 'preview', name: 'course', revision: f.revision, projectsRoot: f.destination, serialize: f.serialize })
      assert.equal(existsSync(join(f.destination, 'course', 'source', 'index.qmd')), format === 'qmd')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  }
})

test('refuses corrupt bytes without making a project visible', async () => {
  const f = await fixture()
  try {
    const artifact = structuredClone(f.artifact)
    artifact.output[0].content = Buffer.from('corrupt').toString('base64')
    await assert.rejects(importProjectPromotion({ artifact, sourceEnvironment: 'preview', name: 'course', revision: f.revision, projectsRoot: f.destination, serialize: f.serialize }), /artifact hash mismatch/)
    assert.equal(existsSync(join(f.destination, 'course', 'project.json')), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('identical retry is idempotent and differing retry refuses', async () => {
  const f = await fixture()
  try {
    await importProjectPromotion({ artifact: f.artifact, sourceEnvironment: 'preview', name: 'course', revision: f.revision, projectsRoot: f.destination, serialize: f.serialize })
    assert.equal((await importProjectPromotion({ artifact: f.artifact, sourceEnvironment: 'preview', name: 'course', revision: f.revision, projectsRoot: f.destination, serialize: f.serialize })).alreadyPromoted, true)
    await assert.rejects(importProjectPromotion({ artifact: { ...f.artifact, revision: 'a'.repeat(40) }, sourceEnvironment: 'preview', name: 'course', revision: 'a'.repeat(40), projectsRoot: f.destination, serialize: f.serialize }), /identity mismatch/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('source identity race aborts the coherent snapshot', async () => {
  const f = await fixture()
  try {
    let calls = 0
    const racing = {
      ...f.lifecycle,
      listRevisionLifecycles(name) {
        calls++
        const rows = f.lifecycle.listRevisionLifecycles(name)
        return calls > 1 ? rows.map(row => ({ ...row, acceptSeq: row.acceptSeq + 1 })) : rows
      },
    }
    await assert.rejects(exportProjectPromotion({ name: 'course', revision: f.revision, sourceEnvironment: 'preview', projectRoot: f.source, lifecycleStore: racing, serialize: f.serialize }), /changed during promotion snapshot/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('activation race preserves the winner', async () => {
  const f = await fixture()
  try {
    const serialize = async (_name, operation) => {
      mkdirSync(join(f.destination, 'course'), { recursive: true })
      writeFileSync(join(f.destination, 'course', 'project.json'), JSON.stringify({ name: 'winner' }))
      return operation()
    }
    await assert.rejects(importProjectPromotion({ artifact: f.artifact, sourceEnvironment: 'preview', name: 'course', revision: f.revision, projectsRoot: f.destination, serialize }), /already exists/)
    assert.equal(JSON.parse(readFileSync(join(f.destination, 'course', 'project.json'))).name, 'winner')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('trusted environment and exact revision are pinned outside artifact hashes', async () => {
  const f = await fixture()
  try {
    await assert.rejects(importProjectPromotion({ artifact: f.artifact, sourceEnvironment: 'production', name: 'course', revision: f.revision, projectsRoot: f.destination, serialize: f.serialize }), /trusted promotion identity mismatch/)
    await assert.rejects(importProjectPromotion({ artifact: f.artifact, sourceEnvironment: 'preview', name: 'course', revision: 'b'.repeat(40), projectsRoot: f.destination, serialize: f.serialize }), /trusted promotion identity mismatch/)
    assert.equal(existsSync(join(f.destination, 'course')), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('path traversal and unexpected symlinks are refused', async () => {
  const f = await fixture()
  try {
    const artifact = structuredClone(f.artifact)
    artifact.output.push({ path: '../escape', content: Buffer.from('escape').toString('base64') })
    artifact.sha256 = promotionArtifactHash(artifact)
    await assert.rejects(importProjectPromotion({ artifact, sourceEnvironment: 'preview', name: 'course', revision: f.revision, projectsRoot: f.destination, serialize: f.serialize }), /invalid project promotion path/)
    symlinkSync('/tmp', join(f.source, 'output', 'outside'))
    await assert.rejects(exportProjectPromotion({ name: 'course', revision: f.revision, sourceEnvironment: 'preview', projectRoot: f.source, lifecycleStore: f.lifecycle, serialize: f.serialize }), /refuses symlink/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('nonterminal lifecycle and corrupt git history never activate', async () => {
  const f = await fixture()
  try {
    const nonterminal = structuredClone(f.artifact)
    nonterminal.lifecycle.build.state = 'pending'
    nonterminal.sha256 = promotionArtifactHash(nonterminal)
    await assert.rejects(importProjectPromotion({ artifact: nonterminal, sourceEnvironment: 'preview', name: 'course', revision: f.revision, projectsRoot: f.destination, serialize: f.serialize }), /not terminal successful/)
    const corrupt = structuredClone(f.artifact)
    corrupt.bundle = Buffer.from('not a git bundle').toString('base64')
    corrupt.sha256 = promotionArtifactHash(corrupt)
    await assert.rejects(importProjectPromotion({ artifact: corrupt, sourceEnvironment: 'preview', name: 'course', revision: f.revision, projectsRoot: f.destination, serialize: f.serialize }))
    assert.equal(existsSync(join(f.destination, 'course')), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('activation does not touch checkout, bindings, classroom, rooms, or submissions', async () => {
  const f = await fixture()
  try {
    const sentinels = ['canonical-checkout', 'source-bindings.json', 'classroom.sqlite', 'rooms.sqlite', 'submission-student']
    for (const name of sentinels) writeFileSync(join(f.destination, name), `preserve:${name}`)
    await importProjectPromotion({ artifact: f.artifact, sourceEnvironment: 'preview', name: 'course', revision: f.revision, projectsRoot: f.destination, serialize: f.serialize })
    for (const name of sentinels) assert.equal(readFileSync(join(f.destination, name), 'utf8'), `preserve:${name}`)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('post-activation index failure preserves the activated project', async () => {
  const f = await fixture()
  try {
    await assert.rejects(importProjectPromotion({
      artifact: f.artifact, sourceEnvironment: 'preview', name: 'course', revision: f.revision,
      projectsRoot: f.destination, serialize: f.serialize,
      onActivated: () => { throw new Error('index failed') },
    }), /index failed/)
    assert.equal(JSON.parse(readFileSync(join(f.destination, 'course', 'project.json'), 'utf8')).name, 'course')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a crash before the single directory activation leaves no partial destination', async () => {
  const f = await fixture()
  try {
    await assert.rejects(importProjectPromotion({
      artifact: f.artifact, sourceEnvironment: 'preview', name: 'course', revision: f.revision,
      projectsRoot: f.destination, serialize: f.serialize,
      beforeActivation(pending) {
        assert.equal(existsSync(join(pending, '.source-lifecycle', 'git')), true)
        assert.equal(existsSync(join(pending, 'output', 'index.html')), true)
        assert.equal(existsSync(join(pending, 'build.log')), true)
        assert.equal(existsSync(join(pending, 'project.json')), true)
        throw new Error('injected pre-activation crash')
      },
    }), /injected pre-activation crash/)
    assert.equal(existsSync(join(f.destination, 'course')), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('concurrent project creation after the final absence check cannot be overwritten', async () => {
  const f = await fixture()
  try {
    await initProjectStore(f.destination)
    const result = await importProjectPromotion({
      artifact: f.artifact, sourceEnvironment: 'preview', name: 'course', revision: f.revision,
      projectsRoot: f.destination, serialize: serializeProjectStoreOperation,
      beforeActivation() {
        assert.throws(() => createProject({ name: 'course', title: 'Concurrent creator' }), /already exists/)
        assert.equal(existsSync(join(f.destination, 'course')), false)
      },
    })
    assert.equal(result.promoted, true)
    assert.equal(JSON.parse(readFileSync(join(f.destination, 'course', 'project.json'), 'utf8')).title, 'Course')
  } finally {
    await closeProjectStore()
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('same revision with different existing output is not an identical retry', async () => {
  const f = await fixture()
  try {
    await importProjectPromotion({ artifact: f.artifact, sourceEnvironment: 'preview', name: 'course', revision: f.revision, projectsRoot: f.destination, serialize: f.serialize })
    writeFileSync(join(f.destination, 'course', 'output', 'index.html'), 'different')
    await assert.rejects(importProjectPromotion({ artifact: f.artifact, sourceEnvironment: 'preview', name: 'course', revision: f.revision, projectsRoot: f.destination, serialize: f.serialize }), /already exists/)
    assert.equal(readFileSync(join(f.destination, 'course', 'output', 'index.html'), 'utf8'), 'different')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
