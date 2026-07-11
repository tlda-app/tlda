import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  TASK_DOC_FILENAME,
  materializeTaskDocs,
  resolveProjectCwd,
  resolveTaskProject,
} from '../server/lib/task-doc-materializer.mjs'
import {
  createProjectPartsManifest,
} from '../shared/project-parts.mjs'
import {
  readProjectPartsManifest,
  writeProjectPartsManifest,
} from '../server/lib/project-parts-scanner.mjs'
import { snapshotForContent } from '../server/lib/project-part-writeback.mjs'

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
    projectsProvider: () => [{ name: 'paper', sourceDir: projectRoot }],
    changes: [{ type: 'delegate', task: tasks[0], actor: 'fleet:worker', at: tasks[0].delegated_at }],
  })

  assert.deepEqual(new Set(result.touchedDirs), new Set([projectRoot, globalRoot]))
  const projectDoc = readFileSync(join(projectRoot, TASK_DOC_FILENAME), 'utf8')
  assert.match(projectDoc, /tlda-kind: task-doc/)
  assert.match(projectDoc, /\| subject \| assigned to \| delegator \| status \| created \| updated \| blockers \| details \|/)
  assert.match(projectDoc, /title="task-1">Build single-machine Unified Task Document<\/span>/)
  assert.match(projectDoc, /title="fleet:worker">worker<\/span> \| <span class="task-doc-agent" title="fleet:frontier">frontier<\/span>/)
  assert.match(projectDoc, /datetime="2026-07-05T10:00:00\.000Z"/)
  assert.match(projectDoc, /datetime="2026-07-05T10:15:00\.000Z"/)
  assert.match(projectDoc, />success criteria<\/span>/)

  const globalDoc = readFileSync(join(globalRoot, TASK_DOC_FILENAME), 'utf8')
  assert.doesNotMatch(globalDoc, /^## /m)
  assert.match(globalDoc, /\| project \| subject \| assigned to \| delegator \| status \| created \| updated \| blockers \| details \|/)
  assert.match(globalDoc, /\| paper \| <span class="task-doc-task-subject" title="task-1">Build single-machine Unified Task Document<\/span>/)

  assert.equal(git(['log', '-1', '--format=%an <%ae>'], projectRoot), 'worker <fleet:worker>')
  assert.match(git(['log', '-1', '--format=%s'], projectRoot), /task-doc: delegate/)
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
    projectsProvider: () => [{ name: 'paper', sourceDir: projectRoot }],
    changes: [{ type: 'done', task: closedTask, actor: 'fleet:worker', at: '2026-07-05T10:01:00.000Z' }],
  })

  const projectDoc = readFileSync(join(projectRoot, TASK_DOC_FILENAME), 'utf8')
  assert.match(projectDoc, /# Tasks for paper/)
  assert.match(projectDoc, /\| subject \| assigned to \| delegator \| status \| created \| updated \| blockers \| details \|/)
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

test('materializeTaskDocs preserves existing project parts and manifest authorities', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-doc-preserve-'))
  const projectRoot = join(root, 'paper')
  const globalRoot = join(root, 'fleet')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(globalRoot, { recursive: true })
  writeProjectPartsManifest(projectRoot, createProjectPartsManifest([{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    kind: 'artifact',
    path: 'parts/existing.md',
    title: 'Existing artifact',
    metadata: { anchor: 'keep-me' },
    authority: { originMachine: 'mini', writable: true },
  }], {
    externalAuthorities: [{ originMachine: 'mini', transport: 'daemon-rpc' }],
  }))

  const tasks = [{
    id: 'task-1',
    agent: 'fleet:worker',
    description: 'Task',
    delegated_at: '2026-07-05T10:00:00.000Z',
    status: 'pending',
  }]

  materializeTaskDocs({
    fleetStore: {
      getAllAgents: () => [{ id: 'fleet:worker', friendly_name: 'worker', cwd: projectRoot }],
      getActiveTasks: () => tasks,
    },
    globalDir: globalRoot,
    projectsProvider: () => [{ name: 'paper', sourceDir: projectRoot }],
    changes: [],
  })

  const manifest = readProjectPartsManifest(projectRoot)
  const existing = manifest.parts.find(part => part.id === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  const taskDoc = manifest.parts.find(part => part.kind === 'task-doc')
  assert.equal(existing.path, 'parts/existing.md')
  assert.equal(existing.metadata.anchor, 'keep-me')
  assert.equal(existing.authority.originMachine, 'mini')
  assert.equal(taskDoc.path, TASK_DOC_FILENAME)
  assert.deepEqual(manifest.externalAuthorities, [{ originMachine: 'mini', transport: 'daemon-rpc' }])
})

test('materializeTaskDocs marks conflict and does not clobber externally edited task doc', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-doc-conflict-'))
  const projectRoot = join(root, 'paper')
  const globalRoot = join(root, 'fleet')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(globalRoot, { recursive: true })
  const clean = '# Tasks for paper\n\nclean\n'
  writeFileSync(join(projectRoot, TASK_DOC_FILENAME), clean)
  writeProjectPartsManifest(projectRoot, createProjectPartsManifest([{
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'task-doc',
    path: TASK_DOC_FILENAME,
    title: 'Tasks for paper',
    metadata: {
      managed: true,
      writeback: { status: 'synced', lastCleanSync: snapshotForContent(clean) },
    },
  }]))
  writeFileSync(join(projectRoot, TASK_DOC_FILENAME), '# Tasks for paper\n\nexternal edit\n')

  materializeTaskDocs({
    fleetStore: {
      getAllAgents: () => [{ id: 'fleet:worker', friendly_name: 'worker', cwd: projectRoot }],
      getActiveTasks: () => [{
        id: 'task-1',
        agent: 'fleet:worker',
        description: 'Task',
        delegated_at: '2026-07-05T10:00:00.000Z',
        status: 'pending',
      }],
    },
    globalDir: globalRoot,
    projectsProvider: () => [{ name: 'paper', sourceDir: projectRoot }],
    changes: [],
  })

  assert.equal(readFileSync(join(projectRoot, TASK_DOC_FILENAME), 'utf8'), '# Tasks for paper\n\nexternal edit\n')
  const manifest = readProjectPartsManifest(projectRoot)
  const taskDoc = manifest.parts.find(part => part.id === '11111111-1111-4111-8111-111111111111')
  assert.equal(taskDoc.metadata.writeback.status, 'conflict')
  assert.equal(taskDoc.metadata.writeback.current.hash, snapshotForContent('# Tasks for paper\n\nexternal edit\n').hash)
})

test('materializeTaskDocs fails closed when existing task doc has no clean baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-doc-no-baseline-'))
  const projectRoot = join(root, 'paper')
  const globalRoot = join(root, 'fleet')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(globalRoot, { recursive: true })
  const external = '# Tasks for paper\n\nexternal untracked text\n'
  writeFileSync(join(projectRoot, TASK_DOC_FILENAME), external)
  writeProjectPartsManifest(projectRoot, createProjectPartsManifest([{
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'task-doc',
    path: TASK_DOC_FILENAME,
    title: 'Tasks for paper',
    metadata: { managed: true },
  }]))

  materializeTaskDocs({
    fleetStore: {
      getAllAgents: () => [{ id: 'fleet:worker', friendly_name: 'worker', cwd: projectRoot }],
      getActiveTasks: () => [{
        id: 'task-1',
        agent: 'fleet:worker',
        description: 'Task',
        delegated_at: '2026-07-05T10:00:00.000Z',
        status: 'pending',
      }],
    },
    globalDir: globalRoot,
    projectsProvider: () => [{ name: 'paper', sourceDir: projectRoot }],
    changes: [],
  })

  assert.equal(readFileSync(join(projectRoot, TASK_DOC_FILENAME), 'utf8'), external)
  const manifest = readProjectPartsManifest(projectRoot)
  const taskDoc = manifest.parts.find(part => part.id === '11111111-1111-4111-8111-111111111111')
  assert.equal(taskDoc.metadata.writeback.status, 'conflict')
  assert.equal(taskDoc.metadata.writeback.lastCleanSync, null)
})

test('materializeTaskDocs surfaces writeback failures instead of silently dropping them', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-doc-surface-failure-'))
  const projectRoot = join(root, 'paper')
  const globalRoot = join(root, 'fleet')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(globalRoot, { recursive: true })

  const first = materializeTaskDocs({
    fleetStore: {
      getAllAgents: () => [{ id: 'fleet:worker', friendly_name: 'worker', cwd: projectRoot }],
      getActiveTasks: () => [{
        id: 'task-1',
        agent: 'fleet:worker',
        description: 'Task',
        delegated_at: '2026-07-05T10:00:00.000Z',
        status: 'pending',
      }],
    },
    globalDir: globalRoot,
    projectsProvider: () => [{ name: 'paper', sourceDir: projectRoot }],
    changes: [],
  })
  assert.equal(first.ok, true)

  const failed = materializeTaskDocs({
    fleetStore: {
      getAllAgents: () => [{ id: 'fleet:worker', friendly_name: 'worker', cwd: projectRoot }],
      getActiveTasks: () => [{
        id: 'task-2',
        agent: 'fleet:worker',
        description: 'Task two',
        delegated_at: '2026-07-05T10:01:00.000Z',
        status: 'pending',
      }],
    },
    globalDir: globalRoot,
    projectsProvider: () => [{ name: 'paper', sourceDir: projectRoot }],
    changes: [],
    writebackOptions: {
      beforeInstall: () => writeFileSync(join(projectRoot, TASK_DOC_FILENAME), '# competing project task doc\n'),
    },
  })

  assert.equal(failed.ok, false)
  assert.equal(failed.failures.length, 1)
  assert.equal(failed.failures[0].scope, 'project')
  assert.equal(failed.failures[0].writeback.status, 'conflict')
  assert.equal(readFileSync(join(projectRoot, TASK_DOC_FILENAME), 'utf8'), '# competing project task doc\n')
})

test('materializeTaskDocs surfaces a concurrent lock loser instead of dropping it', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-doc-lock-loser-'))
  const projectRoot = join(root, 'paper')
  const globalRoot = join(root, 'fleet')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(globalRoot, { recursive: true })
  mkdirSync(join(projectRoot, '.TASKS.md.writeback.lock'))

  const result = materializeTaskDocs({
    fleetStore: {
      getAllAgents: () => [{ id: 'fleet:worker', friendly_name: 'worker', cwd: projectRoot }],
      getActiveTasks: () => [{
        id: 'task-1',
        agent: 'fleet:worker',
        description: 'Task',
        delegated_at: '2026-07-05T10:00:00.000Z',
        status: 'pending',
      }],
    },
    globalDir: globalRoot,
    projectsProvider: () => [{ name: 'paper', sourceDir: projectRoot }],
    changes: [],
  })

  assert.equal(result.ok, false)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].scope, 'project')
  assert.equal(result.failures[0].writeback.status, 'failed')
  assert.equal(result.failures[0].writeback.message, 'Backing file is already locked by another writeback')
})
