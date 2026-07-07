import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JSDOM } from 'jsdom'

import { buildMarkdownDocument, stripMarkdownFrontmatter } from '../server/lib/build-markdown.mjs'
import { createProject, initProjectStore, outputDir, sourceDir } from '../server/lib/project-store.mjs'

test('stripMarkdownFrontmatter hides only leading YAML metadata', () => {
  const source = `---
tlda-id: 22222222-2222-4222-8222-222222222222
tlda-kind: task-doc
---

# Tasks

| id | subject |
| --- | --- |
| t1 | body |
`

  const stripped = stripMarkdownFrontmatter(source, { preserveLineNumbers: false })
  assert.match(stripped, /^# Tasks/m)
  assert.equal(stripped.includes('tlda-id'), false)
  assert.equal(stripped.includes('| t1 | body |'), true)
})

test('markdown build does not render YAML frontmatter but keeps body table', async () => {
  const projectsDir = mkdtempSync(join(tmpdir(), 'tlda-md-frontmatter-'))
  initProjectStore(projectsDir)
  createProject({ name: 'task-doc-md', mainFile: 'TASKS.md', format: 'markdown' })

  writeFileSync(join(sourceDir('task-doc-md'), 'TASKS.md'), `---
tlda-id: 22222222-2222-4222-8222-222222222222
tlda-kind: task-doc
---

# Fleet tasks

| id | subject | owner | status | blockers | links |
| --- | --- | --- | --- | --- | --- |
| task-1 | Keep body table | task-doc | pending |  | cwd:/tmp |
`)

  await buildMarkdownDocument('task-doc-md', () => {})

  const html = readFileSync(join(outputDir('task-doc-md'), 'index.html'), 'utf8')
  assert.equal(html.includes('tlda-id'), false)
  assert.equal(html.includes('tlda-kind'), false)
  assert.match(html, /<table\b/)
  assert.match(html, /Keep body table/)
})

test('task-doc markdown render layer sorts filters and pretty-prints fleet ids', async () => {
  const projectsDir = mkdtempSync(join(tmpdir(), 'tlda-md-task-doc-render-'))
  initProjectStore(projectsDir)
  createProject({ name: 'fleet-task-doc', mainFile: 'TASKS.md', format: 'markdown' })

  writeFileSync(join(sourceDir('fleet-task-doc'), 'TASKS.md'), `---
tlda-id: 22222222-2222-4222-8222-222222222222
tlda-kind: task-doc
---

# Fleet tasks

| project | id | subject | owner | status | created | last-modified | blockers | links |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tlda | fleet:4e8f-mr7old | Older task | fleet:4e8f70e3 | pending | 2026-07-05 10:00 UTC | 2026-07-05 10:10 UTC |  | cwd:/tmp |
| other | fleet:16ab-mr7new | Newer task | fleet:16abefc0 | blocked | 2026-07-05 11:00 UTC | 2026-07-05 11:20 UTC | task-a | cwd:/tmp |
`)

  await buildMarkdownDocument('fleet-task-doc', () => {})
  const html = readFileSync(join(outputDir('fleet-task-doc'), 'index.html'), 'utf8')
  assert.match(html, /task-doc-tools/)

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'https://tlda.test/docs/fleet-task-doc/index.html',
    beforeParse(window) {
      window.fetch = async (url) => {
        assert.equal(String(url), '/api/store/agents')
        return {
          ok: true,
          async json() {
            return [
              { id: 'fleet:4e8f70e3', friendly_name: 'task-doc' },
              { id: 'fleet:16abefc0', friendly_name: 'frontier' },
            ]
          },
        }
      }
    },
  })

  await new Promise(resolve => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }))
  await new Promise(resolve => setTimeout(resolve, 20))

  const doc = dom.window.document
  const table = doc.querySelector('table.task-doc-table')
  assert.ok(table)
  assert.equal(doc.querySelectorAll('.task-doc-tools select').length, 2)
  assert.equal(table.tBodies[0].rows[0].cells[2].textContent, 'Older task')

  doc.querySelector('th[data-task-doc-sort="last-modified"]').click()
  assert.equal(table.tBodies[0].rows[0].cells[2].textContent, 'Newer task')

  const projectFilter = doc.querySelector('.task-doc-tools label:first-child select')
  projectFilter.value = 'tlda'
  projectFilter.dispatchEvent(new dom.window.Event('change'))
  assert.equal(table.tBodies[0].rows[0].hidden, true)
  assert.equal(table.tBodies[0].rows[1].hidden, false)

  const ownerCell = Array.from(table.tBodies[0].rows[1].cells).find(cell => cell.dataset.rawValue === 'fleet:4e8f70e3')
  const idCell = Array.from(table.tBodies[0].rows[1].cells).find(cell => cell.dataset.rawValue === 'fleet:4e8f-mr7old')
  assert.equal(ownerCell.textContent, 'task-doc')
  assert.equal(ownerCell.title, 'fleet:4e8f70e3')
  assert.equal(idCell.textContent, 'task-doc-mr7old')
  assert.equal(idCell.title, 'fleet:4e8f-mr7old')
})

test('ordinary markdown docs do not get task-doc render controls', async () => {
  const projectsDir = mkdtempSync(join(tmpdir(), 'tlda-md-normal-render-'))
  initProjectStore(projectsDir)
  createProject({ name: 'plain-md', mainFile: 'README.md', format: 'markdown' })

  writeFileSync(join(sourceDir('plain-md'), 'README.md'), `# Plain

| status | value |
| --- | --- |
| pending | one |
`)

  await buildMarkdownDocument('plain-md', () => {})

  const html = readFileSync(join(outputDir('plain-md'), 'index.html'), 'utf8')
  assert.doesNotMatch(html, /task-doc-tools/)
  assert.doesNotMatch(html, /data-task-doc-sort/)
})
