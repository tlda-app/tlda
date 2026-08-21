import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { migrateDocumentAxes } from './migrate-document-axes-v1.mjs'
import { closeProjectStore, initProjectStore } from '../server/lib/project-store.mjs'

async function fixture(projects) {
  const root = await mkdtemp(join(tmpdir(), 'tlda-document-axes-'))
  for (const [name, project] of Object.entries(projects)) {
    await mkdir(join(root, name), { recursive: true })
    await writeFile(join(root, name, 'project.json'), JSON.stringify({ name, ...project }, null, 2))
  }
  return root
}

const readProject = async (root, name) => JSON.parse(await readFile(join(root, name, 'project.json'), 'utf8'))

test('runtime rejects legacy storage without mutating it', async () => {
  const root = await fixture({ old: { format: 'svg', mainFile: 'main.tex' } })
  const before = await readFile(join(root, 'old', 'project.json'), 'utf8')
  await assert.rejects(initProjectStore(root), /explicit document-axes-v1 storage migration/)
  assert.equal(await readFile(join(root, 'old', 'project.json'), 'utf8'), before)
})

test('explicit migration removes format and admits the converted store', async () => {
  const root = await fixture({ talk: { format: 'qmd', renderedFormat: 'slides', mainFile: 'talk.qmd' } })
  const result = await migrateDocumentAxes(root)
  assert.equal(result.state, 'complete')
  assert.deepEqual(await readProject(root, 'talk'), {
    name: 'talk', renderedFormat: 'slides', mainFile: 'talk.qmd',
    sourceFormat: 'qmd', renderer: 'quarto', documentFormat: 'slides',
  })
  await initProjectStore(root)
  await closeProjectStore()
})

test('an interrupted conversion resumes or restores from its durable journal', async () => {
  const root = await fixture({ a: { format: 'markdown' }, b: { format: 'book', members: [] } })
  await assert.rejects(migrateDocumentAxes(root, { failAfter: 1 }), /interruption/)
  assert.equal(Object.hasOwn(await readProject(root, 'a'), 'format'), false)
  assert.equal((await readProject(root, 'b')).format, 'book')
  assert.equal((await migrateDocumentAxes(root)).state, 'complete')
  assert.equal(Object.hasOwn(await readProject(root, 'b'), 'format'), false)
  assert.equal((await migrateDocumentAxes(root, { recover: true })).state, 'recovered')
  assert.equal((await readProject(root, 'a')).format, 'markdown')
  assert.equal((await readProject(root, 'b')).format, 'book')
})
