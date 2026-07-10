import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { JSDOM } from 'jsdom'

import { initProjectStore, projectPartsRoot, readProjectPartsManifest } from '../server/lib/project-store.mjs'
import { listProjectPartColumns } from '../server/lib/document-columns.mjs'
import { renderMarkdownColumnHtml } from '../server/lib/build-markdown.mjs'
import projectRoutes from '../server/routes/projects.mjs'
import {
  TASK_DOC_FILENAME,
  TASK_DOC_PROJECT_ID,
  materializeTaskDocs,
} from '../server/lib/task-doc-materializer.mjs'

function setupProject(name, project = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-task-doc-'))
  initProjectStore(root)
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'output'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    name,
    title: name,
    format: 'svg',
    mainFile: 'main.tex',
    ...project,
  }))
  return { root, dir, source: path.join(dir, 'source') }
}

function fleetStore({ tasks = [], agents = [] } = {}) {
  return {
    getActiveTasks: () => tasks,
    getAllAgents: () => agents,
  }
}

test('project task-doc refresh writes a first-class project part', () => {
  const { source } = setupProject('phi')
  const store = fleetStore({
    agents: [{ id: 'agent-1', friendly_name: 'planner' }],
    tasks: [{
      id: 'task-1',
      agent: 'agent-1',
      delegated_by: 'agent-1',
      description: 'Make the task document tryable',
      status: 'working',
      delegated_at: '2026-07-10T20:00:00.000Z',
      updated_at: '2026-07-10T21:00:00.000Z',
      metadata: { project: 'phi' },
    }],
  })

  const result = materializeTaskDocs({
    fleetStore: store,
    projectNames: ['phi'],
    useProjectPartsRoot: true,
    globalDir: path.join(source, '..', 'global-task-doc'),
    git: () => '',
  })

  assert.deepEqual(result.touchedDirs.sort(), [
    path.join(source, '..', 'global-task-doc'),
    projectPartsRoot('phi'),
  ].sort())

  const taskDoc = fs.readFileSync(path.join(source, TASK_DOC_FILENAME), 'utf8')
  assert.match(taskDoc, /tlda-kind: task-doc/)
  assert.match(taskDoc, /# Tasks for phi/)
  assert.match(taskDoc, /Make the task document tryable/)
  assert.match(taskDoc, /\| subject \| assigned to \| delegator \| status \| created \| updated \| blockers \| details \|/)
  assert.match(taskDoc, /planner/)
  assert.match(taskDoc, /self-assigned/)
  assert.match(taskDoc, /<time class="task-doc-time" datetime="2026-07-10T20:00:00.000Z"/)
  assert.doesNotMatch(taskDoc, /\| task-1 \|/)

  const manifest = readProjectPartsManifest('phi')
  assert.deepEqual(manifest.parts.map(part => ({
    id: part.id,
    kind: part.kind,
    path: part.path,
    title: part.title,
  })), [{
    id: TASK_DOC_PROJECT_ID,
    kind: 'task-doc',
    path: TASK_DOC_FILENAME,
    title: 'Tasks for phi',
  }])

  const columns = listProjectPartColumns('phi')
  assert.equal(columns.length, 1)
  assert.equal(columns[0].file, 'TASKS.html')
  assert.equal(columns[0].width > 1800, true)
  assert.equal(columns[0].metadata.kind, 'task-doc')
})

test('project task-doc refresh creates an empty managed part for tryability', () => {
  const { source } = setupProject('empty-project')

  materializeTaskDocs({
    fleetStore: fleetStore(),
    projectNames: ['empty-project'],
    useProjectPartsRoot: true,
    globalDir: path.join(source, '..', 'global-task-doc'),
    git: () => '',
  })

  const taskDoc = fs.readFileSync(path.join(source, TASK_DOC_FILENAME), 'utf8')
  assert.match(taskDoc, /# Tasks for empty-project/)
  assert.match(taskDoc, /\| subject \| assigned to \| delegator \| status \| created \| updated \| blockers \| details \|/)

  const manifest = readProjectPartsManifest('empty-project')
  assert.equal(manifest.parts[0].kind, 'task-doc')
  assert.equal(manifest.parts[0].metadata.managed, true)
})

test('project task-doc refresh endpoint exposes the task doc as a document part', async () => {
  setupProject('route-project')
  const app = express()
  app.use(express.json())
  app.locals.fleetStore = fleetStore({
    agents: [{ id: 'agent-2', friendly_name: 'route planner' }],
    tasks: [{
      id: 'task-2',
      agent: 'agent-2',
      description: 'Route task docs into the viewer',
      status: 'pending',
      delegated_at: '2026-07-10T20:00:00.000Z',
      metadata: { project: 'route-project' },
    }],
  })
  app.use('/api/projects', projectRoutes)

  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const refresh = await fetch(`http://127.0.0.1:${port}/api/projects/route-project/task-doc/refresh`, {
      method: 'POST',
    })
    assert.equal(refresh.status, 200)
    const payload = await refresh.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.part.kind, 'task-doc')
    assert.equal(payload.part.outputFile, 'TASKS.html')

    const parts = await fetch(`http://127.0.0.1:${port}/api/projects/route-project/parts`)
    assert.equal(parts.status, 200)
    const pageInfo = await parts.json()
    assert.equal(pageInfo.length, 1)
    assert.equal(pageInfo[0].file, 'TASKS.html')
    assert.equal(pageInfo[0].metadata.kind, 'task-doc')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('task-doc markdown renderer installs filters, search, and sorting controls', async () => {
  const html = renderMarkdownColumnHtml({
    title: 'Tasks',
    isTaskDoc: true,
    source: `---
tlda-kind: task-doc
---

# Tasks

| project | subject | assigned to | delegator | status | created | updated | blockers | details |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| phi | Write the prototype | agent-1 | self-assigned | working | 2026-07-10 20:00 UTC | 2026-07-10 21:00 UTC |  |  |
| phi | Fix browser polish | agent-2 | planner | pending | 2026-07-10 20:30 UTC | 2026-07-10 21:30 UTC |  |  |
`,
  })
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/docs/phi/TASKS.html',
  })
  await new Promise(resolve => dom.window.setTimeout(resolve, 20))

  const doc = dom.window.document
  assert.equal(doc.querySelector('select[data-task-doc-filter="project"]')?.value, '')
  assert.equal(doc.querySelector('select[data-task-doc-filter="status"]')?.value, '')
  assert.equal(doc.querySelector('input[data-task-doc-filter="search"]')?.getAttribute('placeholder'), 'find task')
  assert.equal(doc.querySelector('.task-doc-row-count')?.textContent, '2 shown')
  assert.equal(!!doc.querySelector('.task-doc-table-wrap'), true)
  const updated = [...doc.querySelectorAll('th')].find(th => th.textContent.trim() === 'updated')
  assert.equal(updated.getAttribute('aria-sort'), 'descending')
  assert.equal(doc.querySelector('tbody tr:first-child')?.textContent.includes('Fix browser polish'), true)

  const search = doc.querySelector('input[data-task-doc-filter="search"]')
  search.value = 'browser'
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  const visibleRows = [...doc.querySelectorAll('tbody tr')].filter(row => !row.hidden)
  assert.equal(doc.querySelector('.task-doc-row-count')?.textContent, '1 shown')
  assert.equal(visibleRows[0].textContent.includes('Fix browser polish'), true)

  const created = [...doc.querySelectorAll('th')].find(th => th.textContent.trim() === 'created')
  created.click()
  assert.equal(created.getAttribute('aria-sort'), 'descending')
})
