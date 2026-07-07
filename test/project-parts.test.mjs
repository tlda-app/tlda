import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  DEFAULT_PART_TITLE,
  createProjectPartRecord,
  createProjectPartsManifest,
  parseMarkdownPart,
} from '../shared/project-parts.mjs'
import {
  projectPartsManifestPath,
  readProjectPartsManifest,
  recoverProjectPartsManifest,
  scanProjectMarkdownParts,
  writeProjectPartsManifest,
} from '../server/lib/project-parts-scanner.mjs'
import {
  createProject,
  initProjectStore,
  projectPartsManifestPath as storeProjectPartsManifestPath,
  readProjectPartsManifest as storeReadProjectPartsManifest,
  recoverProjectPartsManifest as storeRecoverProjectPartsManifest,
} from '../server/lib/project-store.mjs'

test('parseMarkdownPart reads YAML identity and heading title', () => {
  const parsed = parseMarkdownPart(`---
tlda-id: 7d8c0f2e-3e40-44dd-a6d3-58d3bb2f1870
tlda-kind: note
---

# Optional title {#stable-anchor}

Body text.
`)

  assert.equal(parsed.id, '7d8c0f2e-3e40-44dd-a6d3-58d3bb2f1870')
  assert.equal(parsed.kind, 'note')
  assert.equal(parsed.title, 'Optional title')
  assert.equal(parsed.valid, true)
})

test('parseMarkdownPart title fallback uses first meaningful line then contextual label', () => {
  const firstLine = parseMarkdownPart(`---
tlda-id: 3f2f64b4-c5ed-42b6-a97f-b0f3212403cf
---


First useful sentence.
`)
  assert.equal(firstLine.title, 'First useful sentence.')

  const contextual = parseMarkdownPart(`---
tlda-id: 1d21119f-536c-4b17-8384-352dd8e8f98b
---

`, { contextualTitle: 'note near Theorem 2.1' })
  assert.equal(contextual.title, 'note near Theorem 2.1')

  const untitled = parseMarkdownPart('')
  assert.equal(untitled.title, DEFAULT_PART_TITLE)
})

test('project part manifest can represent project paths and external authorities', () => {
  const projectPart = createProjectPartRecord({
    id: '2f065360-69c3-4ec4-a7e1-02e075485d2b',
    kind: 'note',
    path: 'notes/example.md',
    title: 'Example',
  })
  const externalPart = createProjectPartRecord({
    id: 'd8e60be8-c695-4e44-a557-106609207a82',
    kind: 'markdown',
    title: 'External report',
    storage: { type: 'external', materializedPath: 'parts/report.md' },
    authority: { originMachine: 'mini', originPath: '/Users/skip/report.md', writable: true },
  })

  const manifest = createProjectPartsManifest([projectPart, externalPart], {
    externalAuthorities: [{ originMachine: 'mini', transport: 'daemon-rpc' }],
  })

  assert.equal(manifest.version, 1)
  assert.equal(manifest.parts[0].storage.path, 'notes/example.md')
  assert.equal(manifest.parts[1].storage.type, 'external')
  assert.equal(manifest.parts[1].authority.originMachine, 'mini')
  assert.equal(manifest.externalAuthorities[0].transport, 'daemon-rpc')
})

test('scanProjectMarkdownParts recovers managed markdown parts by embedded ids', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-parts-'))
  mkdirSync(join(root, 'notes'), { recursive: true })
  mkdirSync(join(root, 'parts', 'reports'), { recursive: true })
  mkdirSync(join(root, 'other'), { recursive: true })

  writeFileSync(join(root, 'notes', 'note.md'), `---
tlda-id: 4be7e0ea-9196-4b8a-8c2a-d701a2f83a1b
tlda-kind: note
---

# Note title
`)
  writeFileSync(join(root, 'parts', 'reports', 'report.markdown'), `---
tlda-id: ee193cd4-603e-4d15-bf41-deb7904817bb
tlda-kind: report
---

Report first line.
`)
  writeFileSync(join(root, 'notes', 'draft.md'), '# no id yet')
  writeFileSync(join(root, 'other', 'ignored.md'), `---
tlda-id: fdb68912-1f5b-4e16-bff3-ebf198e32ec9
---
`)

  const scanned = scanProjectMarkdownParts(root)

  assert.deepEqual(scanned.errors, [])
  assert.deepEqual(scanned.parts.map(p => p.path), [
    'notes/note.md',
    'parts/reports/report.markdown',
  ])
  assert.equal(scanned.parts[0].id, '4be7e0ea-9196-4b8a-8c2a-d701a2f83a1b')
  assert.equal(scanned.parts[0].title, 'Note title')
  assert.equal(scanned.parts[1].kind, 'report')
  assert.equal(scanned.manifest.parts.length, 2)
})

test('scanProjectMarkdownParts reports invalid and duplicate embedded ids', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-parts-bad-'))
  mkdirSync(join(root, 'notes'), { recursive: true })

  writeFileSync(join(root, 'notes', 'bad.md'), `---
tlda-id: not-a-uuid
---
`)
  writeFileSync(join(root, 'notes', 'one.md'), `---
tlda-id: 77cd241a-6b17-4b1e-8943-005f7ec29fb7
---
`)
  writeFileSync(join(root, 'notes', 'two.md'), `---
tlda-id: 77cd241a-6b17-4b1e-8943-005f7ec29fb7
---
`)

  const scanned = scanProjectMarkdownParts(root)

  assert.equal(scanned.parts.length, 1)
  assert.equal(scanned.errors.length, 2)
  assert.match(scanned.errors[0].error, /Invalid tlda-id/)
  assert.match(scanned.errors[1].error, /Duplicate tlda-id/)
})

test('project parts manifest persists under .tlda and can be recovered from markdown files', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-parts-manifest-'))
  mkdirSync(join(root, 'notes'), { recursive: true })
  writeFileSync(join(root, 'notes', 'note.md'), `---
tlda-id: 1eb06315-c271-4321-a456-dab4078d27e3
tlda-kind: note
---

# Persisted note
`)

  const recovered = recoverProjectPartsManifest(root)
  assert.equal(recovered.parts.length, 1)
  assert.equal(projectPartsManifestPath(root), join(root, '.tlda', 'parts.json'))

  const readBack = readProjectPartsManifest(root)
  assert.equal(readBack.parts[0].id, '1eb06315-c271-4321-a456-dab4078d27e3')
  assert.equal(readBack.parts[0].path, 'notes/note.md')

  const written = writeProjectPartsManifest(root, createProjectPartsManifest([{
    id: 'f04fd6f4-b3b1-4dd7-bb39-9668b2f87588',
    kind: 'report',
    path: 'parts/report.md',
    title: 'Report',
  }]))
  assert.equal(written.parts[0].kind, 'report')
  assert.equal(readProjectPartsManifest(root).parts[0].path, 'parts/report.md')
})

test('project-store exposes project parts manifest helpers for the source namespace', () => {
  const projectsDir = mkdtempSync(join(tmpdir(), 'tlda-project-store-parts-'))
  initProjectStore(projectsDir)
  createProject({ name: 'paper', mainFile: 'main.tex' })

  const sourceRoot = join(projectsDir, 'paper', 'source')
  mkdirSync(join(sourceRoot, 'notes'), { recursive: true })
  writeFileSync(join(sourceRoot, 'notes', 'note.md'), `---
tlda-id: 277955c5-603f-4c8e-8f44-8eda07bbd8aa
tlda-kind: note
---

# Store note
`)

  const recovered = storeRecoverProjectPartsManifest('paper')
  assert.equal(recovered.parts.length, 1)
  assert.equal(storeProjectPartsManifestPath('paper'), join(sourceRoot, '.tlda', 'parts.json'))
  assert.equal(storeReadProjectPartsManifest('paper').parts[0].title, 'Store note')
})
