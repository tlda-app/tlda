import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSourceMaterializer } from './source-materializer.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const entry = (path, value) => ({ path, sha256: sha(value), size: Buffer.byteLength(value) })
const blob = value => [sha(value), Buffer.from(value).toString('base64')]

test('only an authoritative seed establishes a materialized base', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-materializer-seed-'))
  try {
    const sourceDir = join(root, 'checkout')
    mkdirSync(sourceDir)

    const ordinary = createSourceMaterializer({ journalPath: join(root, 'ordinary.json') })
    ordinary.seedBinding('ordinary', sourceDir, null)
    ordinary.seedBinding('ordinary', sourceDir, 'revision-1')
    assert.equal(ordinary.readBinding('ordinary').serverHeadRevision, 'revision-1')
    assert.equal(ordinary.readBinding('ordinary').materializedRevision, null)

    const authoritative = createSourceMaterializer({ journalPath: join(root, 'authoritative.json') })
    authoritative.seedBinding('authoritative', sourceDir, null)
    authoritative.seedBinding('authoritative', sourceDir, 'revision-1', { authoritative: true })
    assert.equal(authoritative.readBinding('authoritative').serverHeadRevision, 'revision-1')
    assert.equal(authoritative.readBinding('authoritative').materializedRevision, 'revision-1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('materializer durably applies add change delete and preserves unmanaged paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-materializer-'))
  try {
    const sourceDir = join(root, 'checkout')
    const journalPath = join(root, 'materializations.json')
    writeFileSync(join(root, 'placeholder'), '')
    mkdirSync(sourceDir)
    writeFileSync(join(sourceDir, 'change.tex'), 'base change\n')
    writeFileSync(join(sourceDir, 'delete.tex'), 'base delete\n')
    writeFileSync(join(sourceDir, 'unmanaged.txt'), 'leave me\n')

    const command = {
      bindingId: 'binding-1',
      sourceDir,
      previousRevision: 'revision-1',
      sourceRevision: 'revision-2',
      baseManifest: [entry('change.tex', 'base change\n'), entry('delete.tex', 'base delete\n')],
      targetManifest: [entry('add.tex', 'added\n'), entry('change.tex', 'accepted change\n')],
      blobs: Object.fromEntries([blob('added\n'), blob('accepted change\n')]),
    }
    const first = createSourceMaterializer({ journalPath })
    first.plan(command)
    const result = first.apply('binding-1', 'revision-2')
    assert.equal(result.state, 'materialized')
    assert.equal(readFileSync(join(sourceDir, 'add.tex'), 'utf8'), 'added\n')
    assert.equal(readFileSync(join(sourceDir, 'change.tex'), 'utf8'), 'accepted change\n')
    assert.equal(existsSync(join(sourceDir, 'delete.tex')), false)
    assert.equal(readFileSync(join(sourceDir, 'unmanaged.txt'), 'utf8'), 'leave me\n')

    const restarted = createSourceMaterializer({ journalPath })
    assert.equal(restarted.readBinding('binding-1').serverHeadRevision, 'revision-2')
    assert.equal(restarted.readBinding('binding-1').materializedRevision, 'revision-2')
    assert.equal(restarted.readBinding('binding-1').activeTargetRevision, null)
    assert.equal(restarted.apply('binding-1', 'revision-2').state, 'materialized')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('unmanaged add collision is durable conflict and never overwrites local bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-materializer-conflict-'))
  try {
    const sourceDir = join(root, 'checkout')
    mkdirSync(sourceDir)
    writeFileSync(join(sourceDir, 'collision.bin'), 'local bytes')
    const journalPath = join(root, 'materializations.json')
    const materializer = createSourceMaterializer({ journalPath })
    materializer.plan({
      bindingId: 'binding-2',
      sourceDir,
      previousRevision: 'revision-1',
      sourceRevision: 'revision-2',
      baseManifest: [],
      targetManifest: [entry('collision.bin', 'accepted bytes')],
      blobs: Object.fromEntries([blob('accepted bytes')]),
    })
    const result = materializer.apply('binding-2', 'revision-2')
    assert.equal(result.state, 'conflicted')
    assert.equal(result.conflicts[0].reason, 'unmanaged-add-collision')
    assert.equal(readFileSync(join(sourceDir, 'collision.bin'), 'utf8'), 'local bytes')
    assert.equal(materializer.readBinding('binding-2').materializedRevision, 'revision-1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('restart resumes after a completed path without rewriting it', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-materializer-restart-'))
  try {
    const sourceDir = join(root, 'checkout')
    mkdirSync(sourceDir)
    const journalPath = join(root, 'materializations.json')
    let crashed = false
    const first = createSourceMaterializer({
      journalPath,
      fault(point) {
        if (!crashed && point === 'after-path:a.tex') {
          crashed = true
          throw new Error('injected crash after first completed path')
        }
      },
    })
    const command = {
      bindingId: 'binding-3',
      sourceDir,
      previousRevision: 'revision-1',
      sourceRevision: 'revision-2',
      baseManifest: [],
      targetManifest: [entry('a.tex', 'a\n'), entry('b.tex', 'b\n')],
      blobs: Object.fromEntries([blob('a\n'), blob('b\n')]),
    }
    first.plan(command)
    assert.throws(() => first.apply('binding-3', 'revision-2'), /injected crash/)
    assert.equal(readFileSync(join(sourceDir, 'a.tex'), 'utf8'), 'a\n')

    const restarted = createSourceMaterializer({ journalPath })
    assert.equal(restarted.apply('binding-3', 'revision-2').state, 'materialized')
    assert.equal(readFileSync(join(sourceDir, 'b.tex'), 'utf8'), 'b\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
