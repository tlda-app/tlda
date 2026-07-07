import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  TASK_DOC_FILENAME,
  materializeTaskDocs,
  resolveProjectCwd,
  resolveTaskProject,
} from '../server/lib/task-doc-materializer.mjs'
import { createProjectPartsManifest } from '../shared/project-parts.mjs'
import {
  readProjectPartsManifest,
  writeProjectPartsManifest,
} from '../server/lib/project-parts-scanner.mjs'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function initRepo(dir) {
  git(['init'], dir)
  git(['config', 'user.name', 'tester'], dir)
  git(['config', 'user.email', 'tester@example.test'], dir)
  writeFileSync(join(dir, 'README.md'), '# repo\n')
  git(['add', 'README.md'], dir)
  git(['commit', '-m', 'initial'], dir)
}

test('materializeTaskDocs writes project and global markdown tables and attributed commits', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-doc-'))
  const projectRoot = join(root, 'paper')
  const globalRoot = join(root, 'fleet')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(globalRoot, { recursive: true })
  initRepo(projectRoot)
  initRepo(globalRoot)

  const agents = [
    { id: 'fleet:worker', friendly_name: 'worker', cwd: projectRoot },
    { id: 'fleet:frontier', friendly_name: 'frontier', cwd: root },
  ]
  const tasks = [{
    id: 'task-1',
    agent: 'fleet:worker',
    description: 'Build single-machine Unified Task Document',
    delegated_by: 'fleet:frontier',
    delegated_at: '2026-07-05T10:00:00.000Z',
    updated_at: '2026-07-05T10:15:00.000Z',
    status: 'pending',
    success_criteria: ['sample exists'],
  }]
  const fleetStore = {
    getAllAgents: () => agents,
    getActiveTasks: () => tasks,
  }

  const result = materializeTaskDocs({
    fleetStore,
    globalDir: globalRoot,
    projectsProvider: () => [{ name: 'paper', sourceDir: projectRoot, taskDocRoot: projectRoot }],
    changes: [{ type: 'delegate', task: tasks[0], actor: 'fleet:worker', at: tasks[0].delegated_at }],
  })

  assert.deepEqual(new Set(result.touchedDirs), new Set([projectRoot, globalRoot]))
  const projectDoc = readFileSync(join(projectRoot, TASK_DOC_FILENAME), 'utf8')
  assert.match(projectDoc, /tlda-kind: task-doc/)
  assert.match(projectDoc, /\| id \| subject \| owner \| status \| created \| last-modified \| blockers \| links \|/)
  assert.match(projectDoc, /\| task-1 \| Build single-machine Unified Task Document \| fleet:worker \| pending \| 2026-07-05 10:00 UTC \| 2026-07-05 10:15 UTC \|  \| criteria<br>cwd:/)

  const globalDoc = readFileSync(join(globalRoot, TASK_DOC_FILENAME), 'utf8')
  assert.doesNotMatch(globalDoc, /^## /m)
  assert.match(globalDoc, /\| project \| id \| subject \| owner \| status \| created \| last-modified \| blockers \| links \|/)
  assert.match(globalDoc, /\| paper \| task-1 \| Build single-machine Unified Task Document \| fleet:worker \| pending \| 2026-07-05 10:00 UTC \| 2026-07-05 10:15 UTC \|  \| criteria<br>cwd:/)

  assert.equal(git(['log', '-1', '--format=%an <%ae>'], projectRoot), 'worker <fleet:worker>')
  assert.match(git(['log', '-1', '--format=%s'], projectRoot), /task-doc: delegate/)
})

test('materializeTaskDocs preserves unrelated project parts in the manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-doc-preserve-parts-'))
  const projectRoot = join(root, 'paper')
  const globalRoot = join(root, 'fleet')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(globalRoot, { recursive: true })

  writeProjectPartsManifest(projectRoot, createProjectPartsManifest([{
    id: '99999999-9999-4999-8999-999999999999',
    kind: 'artifact',
    path: 'parts/existing.md',
    title: 'Existing artifact',
    metadata: { sourceAgent: 'agent' },
  }]))

  const tasks = [{
    id: 'task-keep-manifest',
    agent: 'fleet:worker',
    description: 'Keep existing manifest entries',
    delegated_at: '2026-07-05T10:00:00.000Z',
    status: 'pending',
  }]

  materializeTaskDocs({
    fleetStore: {
      getAllAgents: () => [{ id: 'fleet:worker', friendly_name: 'worker', cwd: projectRoot }],
      getActiveTasks: () => tasks,
    },
    globalDir: globalRoot,
    projectsProvider: () => [{ name: 'paper', sourceDir: projectRoot, taskDocRoot: projectRoot }],
    changes: [{ type: 'delegate', task: tasks[0], actor: 'fleet:worker', at: tasks[0].delegated_at }],
    git: () => '',
  })

  const manifest = readProjectPartsManifest(projectRoot)
  assert.deepEqual(new Set(manifest.parts.map(part => part.id)), new Set([
    '11111111-1111-4111-8111-111111111111',
    '99999999-9999-4999-8999-999999999999',
  ]))
  assert.equal(manifest.parts.find(part => part.kind === 'artifact').title, 'Existing artifact')
  assert.equal(manifest.parts.find(part => part.kind === 'task-doc').title, 'Tasks for paper')
})

test('materializeTaskDocs does not write or commit ordinary project source dirs', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-doc-ordinary-project-'))
  const projectRoot = join(root, 'paper')
  const globalRoot = join(root, 'fleet')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(globalRoot, { recursive: true })
  initRepo(projectRoot)
  initRepo(globalRoot)

  const tasks = [{
    id: 'task-ordinary',
    agent: 'fleet:worker',
    description: 'Classified in global doc only',
    delegated_at: '2026-07-05T10:00:00.000Z',
    updated_at: '2026-07-05T10:15:00.000Z',
    status: 'pending',
  }]

  const result = materializeTaskDocs({
    fleetStore: {
      getAllAgents: () => [{ id: 'fleet:worker', friendly_name: 'worker', cwd: projectRoot }],
      getActiveTasks: () => tasks,
    },
    globalDir: globalRoot,
    projectsProvider: () => [{ name: 'paper', sourceDir: projectRoot }],
    changes: [{ type: 'delegate', task: tasks[0], actor: 'fleet:worker', at: tasks[0].delegated_at }],
  })

  assert.deepEqual(result.touchedDirs, [globalRoot])
  assert.equal(existsSync(join(projectRoot, TASK_DOC_FILENAME)), false)
  assert.equal(existsSync(join(projectRoot, '.tlda', 'parts.json')), false)
  assert.equal(git(['log', '-1', '--format=%s'], projectRoot), 'initial')

  const globalDoc = readFileSync(join(globalRoot, TASK_DOC_FILENAME), 'utf8')
  assert.match(globalDoc, /\| paper \| task-ordinary \| Classified in global doc only \| fleet:worker \| pending \|/)
})

test('resolveTaskProject maps .worktrees checkout cwd to the underlying project root', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-doc-worktree-'))
  const projectRoot = join(root, 'paper')
  const worktreeCwd = join(projectRoot, '.worktrees', 'slice', 'src')
  mkdirSync(worktreeCwd, { recursive: true })

  assert.equal(resolveProjectCwd(worktreeCwd), projectRoot)
  assert.deepEqual(
    resolveTaskProject(worktreeCwd, [{ name: 'paper', taskDocRoot: projectRoot, resolvedRoot: projectRoot }]),
    { name: 'paper', root: projectRoot },
  )
})

test('materializeTaskDocs empties a changed project doc when its last task closes', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-doc-empty-'))
  const projectRoot = join(root, 'paper')
  const globalRoot = join(root, 'fleet')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(globalRoot, { recursive: true })

  const agents = [{ id: 'fleet:worker', friendly_name: 'worker', cwd: projectRoot }]
  const closedTask = {
    id: 'task-closed',
    agent: 'fleet:worker',
    description: 'Closed task',
    delegated_at: '2026-07-05T10:00:00.000Z',
    status: 'done',
  }

  materializeTaskDocs({
    fleetStore: {
      getAllAgents: () => agents,
      getActiveTasks: () => [],
    },
    globalDir: globalRoot,
    projectsProvider: () => [{ name: 'paper', sourceDir: projectRoot, taskDocRoot: projectRoot }],
    changes: [{ type: 'done', task: closedTask, actor: 'fleet:worker', at: '2026-07-05T10:01:00.000Z' }],
  })

  const projectDoc = readFileSync(join(projectRoot, TASK_DOC_FILENAME), 'utf8')
  assert.match(projectDoc, /# Tasks for paper/)
  assert.match(projectDoc, /\| id \| subject \| owner \| status \| created \| last-modified \| blockers \| links \|/)
  assert.doesNotMatch(projectDoc, /task-closed/)
})

test('materializeTaskDocs excludes deleted task rows from current docs', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-doc-deleted-'))
  const projectRoot = join(root, 'paper')
  const globalRoot = join(root, 'fleet')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(globalRoot, { recursive: true })

  materializeTaskDocs({
    fleetStore: {
      getAllAgents: () => [{ id: 'fleet:worker', friendly_name: 'worker', cwd: projectRoot }],
      getActiveTasks: () => [{
        id: 'task-deleted',
        agent: 'fleet:worker',
        description: 'Deleted task',
        delegated_at: '2026-07-05T10:00:00.000Z',
        status: 'deleted',
      }],
    },
    globalDir: globalRoot,
    projectsProvider: () => [{ name: 'paper', sourceDir: projectRoot }],
    changes: [],
  })

  const globalDoc = readFileSync(join(globalRoot, TASK_DOC_FILENAME), 'utf8')
  assert.doesNotMatch(globalDoc, /task-deleted/)
})
