import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { ProjectFilesStoreClient } from './project-files-store-client.mjs'
import {
  closeProjectStore,
  createProject,
  deleteProject,
  initProjectStore,
  listProjects,
  readProject,
  readClientSourceManifest,
  updateProject,
  updateClientSourceManifest,
} from './project-store.mjs'

test('project files worker preserves migration, ordering, atomic replace, and loop responsiveness', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'tlda-project-files-worker-'))
  const root = join(tempRoot, 'projects')
  const projectDir = join(root, 'legacy')
  const outputDir = join(projectDir, 'output')
  const sourceDir = join(projectDir, 'source')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(outputDir, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify({
    name: 'legacy',
    title: 'Legacy Search',
    mainFile: 'main.tex',
    clientSourceManifest: ['z.tex', './a.tex', 'z.tex'],
  }))
  writeFileSync(join(outputDir, 'search-index.json'), JSON.stringify([{
    page: 1,
    label: 'Legacy Search',
    text: 'This rendered-only phrase must not be searchable.',
  }]))
  writeFileSync(join(sourceDir, 'z.tex'), String.raw`The source contains \int spectral banana calculus.`)

  const client = new ProjectFilesStoreClient(root)
  try {
    await client.ready()
    assert.deepEqual(await client.read('legacy'), ['./a.tex', 'z.tex'])
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')), 'clientSourceManifest'), false)

    await assert.rejects(client.replace('legacy', ['next.tex', 'next.tex']))
    assert.deepEqual(await client.read('legacy'), ['./a.tex', 'z.tex'])

    const searchRows = await client.searchContent(String.raw`\int spectral banana calculus`, { currentProject: 'legacy' })
    assert.equal(searchRows.length, 1)
    assert.equal(searchRows[0].type, 'document_content')
    assert.equal(searchRows[0].project, 'legacy')
    assert.equal(searchRows[0].sourceKind, 'source')
    assert.equal((await client.searchContent('rendered-only phrase')).length, 0)

    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 1)
    const paths = Array.from({ length: 10_000 }, (_, index) => `chapters/${String(index).padStart(5, '0')}.tex`)
    const started = performance.now()
    await client.replace('legacy', paths)
    const replaceMs = performance.now() - started
    clearInterval(timer)
    assert.equal((await client.read('legacy')).length, paths.length)
    assert.ok(ticks > 0, `main loop did not tick during ${replaceMs.toFixed(1)}ms replace`)
    console.log(`project-files off-loop proof: replace=${replaceMs.toFixed(1)}ms ticks=${ticks}`)
  } finally {
    await client.close()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('deleteProject clears its manifest through replace(project, [])', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'tlda-project-files-delete-'))
  const root = join(tempRoot, 'projects')
  try {
    await initProjectStore(root)
    createProject({ name: 'paper', title: 'Paper' })
    await updateClientSourceManifest('paper', ['main.tex'])
    await deleteProject('paper')
    createProject({ name: 'paper', title: 'Paper' })
    assert.deepEqual(await readClientSourceManifest('paper'), [])
  } finally {
    await closeProjectStore()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('project metadata reads and updates run through the project files worker', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'tlda-project-metadata-worker-'))
  const root = join(tempRoot, 'projects')
  try {
    await initProjectStore(root)
    createProject({ name: 'paper', title: 'Paper' })
    assert.equal((await readProject('paper')).title, 'Paper')
    assert.deepEqual((await listProjects()).map(project => project.name), ['paper'])
    assert.equal((await updateProject('paper', { title: 'Revised' })).title, 'Revised')
    assert.equal((await readProject('paper')).title, 'Revised')
  } finally {
    await closeProjectStore()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
