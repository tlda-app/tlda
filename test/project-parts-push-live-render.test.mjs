import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { processProjectPush } from '../server/routes/projects.mjs'
import { buildMarkdownDocument } from '../server/lib/build-markdown.mjs'
import { realizeProjectMarkdownArtifact } from '../server/lib/project-artifact-materializer.mjs'
import {
  createProject,
  initProjectStore,
  outputDir,
  projectPartsRoot,
} from '../server/lib/project-store.mjs'
import { initSyncRooms, getLastSignal, closeAllRooms } from '../server/lib/sync-rooms.mjs'
import { readProjectPartsManifest } from '../server/lib/project-parts-scanner.mjs'

afterEach(() => {
  closeAllRooms()
})

function setupSvgProject(name) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-parts-push-'))
  const projectsDir = join(root, 'projects')
  const authorDir = join(root, 'author')
  mkdirSync(projectsDir, { recursive: true })
  mkdirSync(join(authorDir, 'scratch'), { recursive: true })
  initProjectStore(projectsDir)
  initSyncRooms(projectsDir)
  createProject({
    name,
    mainFile: 'main.tex',
    format: 'svg',
    sourceDir: authorDir,
  })
  return { root, authorDir }
}

test('processProjectPush rematerializes an artifact when its external source path changes', async () => {
  const name = 'paper-live-parts'
  const { root, authorDir } = setupSvgProject(name)
  try {
    const sourcePath = join(authorDir, 'scratch', 'live-column-test.md')
    writeFileSync(sourcePath, '# Live column\n\nOld body.\n')

    const created = realizeProjectMarkdownArtifact({
      project: name,
      markdown: readFileSync(sourcePath, 'utf8'),
      sourcePath,
      idFactory: () => '11111111-2222-4333-8444-555555555555',
    })
    assert.equal(created.status, 'ready')

    const result = await processProjectPush(name, {
      files: [{ path: 'scratch/live-column-test.md', content: '# Live column\n\nNew body.\n' }],
      editedBy: 'test-agent',
    })

    assert.equal(result.ok, true)
    assert.equal(result.partsChanged, undefined)

    const materialized = readFileSync(join(projectPartsRoot(name), created.projectPath), 'utf8')
    assert.match(materialized, /New body\./)
    assert.doesNotMatch(materialized, /Old body\./)

    const manifest = readProjectPartsManifest(projectPartsRoot(name))
    assert.equal(manifest.parts.length, 1)
    assert.equal(manifest.parts[0].id, created.projectArtifactId)
    assert.equal(manifest.parts[0].metadata.sourcePath, sourcePath)

    const pageInfoPath = join(outputDir(name), 'page-info.json')
    assert.equal(existsSync(pageInfoPath), true)
    const pageInfo = JSON.parse(readFileSync(pageInfoPath, 'utf8'))
    assert.equal(pageInfo.length, 1)
    assert.equal(pageInfo[0].source.file, created.projectPath)
    assert.deepEqual(pageInfo[0].metadata, {
      partId: created.projectArtifactId,
      kind: 'artifact',
    })

    const reload = getLastSignal(`doc-${name}`, 'signal:reload')
    assert.equal(reload.parts, 1)

    const partsChanged = getLastSignal(`doc-${name}`, 'signal:project-parts-changed')
    assert.deepEqual(partsChanged.files, ['parts/11111111.html'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('processProjectPush does not rerender project parts for unrelated source edits', async () => {
  const name = 'paper-unrelated-parts'
  const { root, authorDir } = setupSvgProject(name)
  try {
    const sourcePath = join(authorDir, 'scratch', 'live-column-test.md')
    writeFileSync(sourcePath, '# Live column\n\nOld body.\n')

    realizeProjectMarkdownArtifact({
      project: name,
      markdown: readFileSync(sourcePath, 'utf8'),
      sourcePath,
      idFactory: () => '22222222-2222-4333-8444-555555555555',
    })

    const result = await processProjectPush(name, {
      files: [{ path: 'main.tex', content: '\\documentclass{article}\\begin{document}x\\end{document}\n' }],
      editedBy: 'test-agent',
    })

    assert.equal(result.ok, true)
    assert.equal(existsSync(join(outputDir(name), 'page-info.json')), false)
    assert.equal(getLastSignal(`doc-${name}`, 'signal:reload'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('markdown builds include external project part source paths in relevant-files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-parts-relevant-'))
  const projectsDir = join(root, 'projects')
  const authorDir = join(root, 'author')
  mkdirSync(projectsDir, { recursive: true })
  mkdirSync(join(authorDir, 'scratch'), { recursive: true })
  initProjectStore(projectsDir)
  initSyncRooms(projectsDir)
  createProject({
    name: 'paper-relevant-parts',
    mainFile: 'README.md',
    format: 'markdown',
    sourceDir: authorDir,
  })

  try {
    const sourcePath = join(authorDir, 'scratch', 'live-part.md')
    writeFileSync(join(projectPartsRoot('paper-relevant-parts'), 'README.md'), '# Main\n\nBody.\n')
    writeFileSync(sourcePath, '# Live part\n\nBody.\n')
    realizeProjectMarkdownArtifact({
      project: 'paper-relevant-parts',
      markdown: readFileSync(sourcePath, 'utf8'),
      sourcePath,
      idFactory: () => '33333333-2222-4333-8444-555555555555',
    })

    await buildMarkdownDocument('paper-relevant-parts', () => {})

    const relevant = JSON.parse(readFileSync(join(outputDir('paper-relevant-parts'), 'relevant-files.json'), 'utf8'))
    assert.ok(relevant.files.includes(sourcePath))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
