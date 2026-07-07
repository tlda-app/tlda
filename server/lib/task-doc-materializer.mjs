import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

import { CONFIG_DIR, loadConfig } from '../../shared/config.mjs'
import { createProjectPartRecord } from '../../shared/project-parts.mjs'
import { listProjects } from './project-store.mjs'
import { upsertProjectPartsManifest } from './project-parts-scanner.mjs'

export const TASK_DOC_FILENAME = 'TASKS.md'
export const TASK_DOC_KIND = 'task-doc'
export const TASK_DOC_PROJECT_ID = '11111111-1111-4111-8111-111111111111'
export const TASK_DOC_GLOBAL_ID = '22222222-2222-4222-8222-222222222222'
export const DEFAULT_TASK_DOC_DEBOUNCE_MS = 1500

const STATUS_ORDER = ['blocked', 'pending', 'working', 'idle']
const DEFAULT_GLOBAL_DIR = join(CONFIG_DIR, 'fleet-task-doc')

export function createTaskDocMaterializer({
  fleetStore,
  debounceMs = DEFAULT_TASK_DOC_DEBOUNCE_MS,
  globalDir = resolveTaskDocGlobalDir(),
  projectsProvider = listProjects,
  logger = console,
  git = runGit,
} = {}) {
  if (!fleetStore) throw new Error('task doc materializer requires fleetStore')
  let timer = null
  let flushing = false
  let pending = []

  async function flush() {
    if (flushing) return
    flushing = true
    const changes = pending
    pending = []
    try {
      materializeTaskDocs({ fleetStore, changes, globalDir, projectsProvider, logger, git })
    } catch (e) {
      logger.warn?.(`[task-doc] materialization failed: ${e.message}`)
    } finally {
      flushing = false
      if (pending.length) schedule()
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
    timer.unref?.()
  }

  return {
    queue(change = {}) {
      pending.push({ ...change, at: change.at || new Date().toISOString() })
      schedule()
    },
    flushNow() {
      if (timer) clearTimeout(timer)
      timer = null
      return flush()
    },
  }
}

export function materializeTaskDocs({
  fleetStore,
  changes = [],
  globalDir = resolveTaskDocGlobalDir(),
  projectsProvider = listProjects,
  logger = console,
  git = runGit,
} = {}) {
  const agents = Array.isArray(fleetStore.getAllAgents?.()) ? fleetStore.getAllAgents() : []
  const agentById = new Map(agents.map(agent => [agent.id, agent]))
  const projects = projectsProvider().map(project => ({
    ...project,
    taskDocRoot: explicitTaskDocRoot(project),
    resolvedRoot: safeRealpath(project.sourceDir || ''),
  })).filter(project => project.sourceDir || project.taskDocRoot)
  const tasks = (fleetStore.getActiveTasks?.() || [])
    .filter(task => !task.synthetic && isCurrentTask(task))
    .sort(compareTasksChronologically)
    .map(task => enrichTask(task, agentById, projects))

  const grouped = groupTasksByProject(tasks)
  const changedProjects = new Map()
  for (const change of changes) {
    if (!change.task || change.task.synthetic) continue
    const enriched = enrichTask(change.task, agentById, projects)
    if (enriched.projectName && enriched.projectRoot) {
      changedProjects.set(enriched.projectName, { name: enriched.projectName, taskDocRoot: enriched.projectRoot })
    }
  }
  const touchedDirs = new Set()

  const projectKeys = new Set([...grouped.projects.keys(), ...changedProjects.keys()])
  for (const projectKey of [...projectKeys].sort()) {
    const rows = grouped.projects.get(projectKey) || []
    const project = grouped.projectMeta.get(projectKey) || changedProjects.get(projectKey)
    if (!project?.taskDocRoot) continue
    writeTaskDoc({
      filePath: join(project.taskDocRoot, TASK_DOC_FILENAME),
      id: TASK_DOC_PROJECT_ID,
      title: `Tasks for ${project.name}`,
      rows,
      heading: `# Tasks for ${project.name}`,
    })
    writeTaskDocManifest(project.taskDocRoot, {
      id: TASK_DOC_PROJECT_ID,
      title: `Tasks for ${project.name}`,
    })
    touchedDirs.add(project.taskDocRoot)
  }

  mkdirSync(globalDir, { recursive: true })
  writeGlobalTaskDoc(join(globalDir, TASK_DOC_FILENAME), tasks)
  writeTaskDocManifest(globalDir, { id: TASK_DOC_GLOBAL_ID, title: 'Fleet tasks' })
  touchedDirs.add(globalDir)

  const commitMessage = describeChanges(changes)
  const actor = actorFromChanges(changes, agentById)
  for (const dir of touchedDirs) {
    commitTaskDoc(dir, {
      message: commitMessage,
      actor,
      git,
      logger,
    })
  }

  return { tasks, touchedDirs: [...touchedDirs], globalDir }
}

export function resolveTaskDocGlobalDir(config = loadConfig()) {
  const raw =
    config.taskDocGlobalDir ||
    config.taskDoc?.globalDir ||
    config.daemon?.taskDocGlobalDir ||
    config.daemon?.taskDoc?.globalDir ||
    null
  return resolve(expandHome(raw || DEFAULT_GLOBAL_DIR))
}

export function resolveTaskProject(cwd, projects = []) {
  if (!cwd) return null
  const root = resolveProjectCwd(cwd)
  if (!root) return null
  const rootReal = safeRealpath(root)
  let best = null
  for (const project of projects) {
    const candidates = [project.taskDocRoot, project.resolvedRoot].filter(Boolean)
    for (const candidate of candidates) {
      if (isSameOrInside(root, candidate) || (rootReal && isSameOrInside(rootReal, candidate))) {
        if (!best || candidate.length > (best.matchLength || 0)) {
          best = { ...project, matchLength: candidate.length }
        }
      }
    }
  }
  return best ? { name: best.name, root: best.taskDocRoot } : null
}

export function resolveProjectCwd(cwd) {
  const abs = resolve(expandHome(cwd))
  const parts = abs.split(sep)
  const worktreeIdx = parts.lastIndexOf('.worktrees')
  if (worktreeIdx > 0) return parts.slice(0, worktreeIdx).join(sep) || sep
  const claudeIdx = parts.lastIndexOf('.claude')
  if (claudeIdx > 0 && parts[claudeIdx + 1] === 'worktrees') {
    return parts.slice(0, claudeIdx).join(sep) || sep
  }
  return gitTopLevel(abs) || abs
}

function enrichTask(task, agentById, projects) {
  const ownerAgent = agentById.get(task.agent)
  const delegator = task.delegated_by ? agentById.get(task.delegated_by) : null
  const project = task.metadata?.project
    ? projectByName(task.metadata.project, projects) || resolveTaskProject(ownerAgent?.cwd, projects)
    : resolveTaskProject(ownerAgent?.cwd, projects)
  return {
    ...task,
    ownerName: ownerAgent?.friendly_name || task.agent,
    ownerCwd: ownerAgent?.cwd || '',
    delegatedByName: delegator?.friendly_name || task.delegated_by || '',
    projectName: task.metadata?.project || project?.name || null,
    projectRoot: project?.root || null,
  }
}

function projectByName(name, projects) {
  const project = projects.find(project => project.name === name)
  return project ? { name: project.name, root: project.taskDocRoot || null } : null
}

function explicitTaskDocRoot(project) {
  return project?.taskDocRoot ? resolve(project.taskDocRoot) : null
}

function groupTasksByProject(tasks) {
  const projects = new Map()
  const projectMeta = new Map()
  const exceptions = []
  for (const task of tasks) {
    if (task.projectName) {
      if (!projects.has(task.projectName)) projects.set(task.projectName, [])
      projects.get(task.projectName).push(task)
      projectMeta.set(task.projectName, { name: task.projectName, taskDocRoot: task.projectRoot })
    } else {
      exceptions.push(task)
    }
  }
  return { projects, projectMeta, exceptions }
}

function writeGlobalTaskDoc(filePath, tasks) {
  const lines = [
    '---',
    `tlda-id: ${TASK_DOC_GLOBAL_ID}`,
    `tlda-kind: ${TASK_DOC_KIND}`,
    '---',
    '',
    '# Fleet tasks',
    '',
    ...markdownTable(tasks, { includeProject: true, sort: compareTasksByModified }),
  ]
  if (!tasks.length) lines.push('No active tasks.', '')
  writeIfChanged(filePath, lines.join('\n'))
}

function writeTaskDoc({ filePath, id, title, rows, heading }) {
  const lines = [
    '---',
    `tlda-id: ${id}`,
    `tlda-kind: ${TASK_DOC_KIND}`,
    '---',
    '',
    heading || `# ${title}`,
    '',
    ...markdownTable(rows),
    '',
  ]
  writeIfChanged(filePath, lines.join('\n'))
}

function markdownTable(rows, { includeProject = false, sort = compareTasksForDoc } = {}) {
  const columns = [
    ...(includeProject ? ['project'] : []),
    'id',
    'subject',
    'owner',
    'status',
    'created',
    'last-modified',
    'blockers',
    'links',
  ]
  const ordered = [...rows].sort(sort)
  return [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...ordered.map(task => taskTableRow(task, { includeProject })),
  ]
}

function taskTableRow(task, { includeProject = false } = {}) {
  const cells = [
    ...(includeProject ? [task.projectName || 'global'] : []),
    task.id,
    task.description || '',
    task.agent || '',
    task.status || '',
    formatTaskTime(task.delegated_at),
    formatTaskTime(task.updated_at || task.completed_at || task.last_checked || task.delegated_at),
    formatBlockers(task),
    formatLinks(task),
  ]
  return `| ${cells.map(tableCell).join(' | ')} |`
}

function writeTaskDocManifest(root, { id, title }) {
  upsertProjectPartsManifest(root, createProjectPartRecord({
    id,
    kind: TASK_DOC_KIND,
    path: TASK_DOC_FILENAME,
    title,
    storage: { type: 'project', path: TASK_DOC_FILENAME },
    metadata: { managed: true },
  }))
}

function commitTaskDoc(dir, { message, actor, git, logger }) {
  if (!isGitRepo(dir)) return false
  try {
    git(['add', TASK_DOC_FILENAME, join('.tlda', 'parts.json')], dir)
    const status = git(['status', '--porcelain=v1', '--', TASK_DOC_FILENAME, join('.tlda', 'parts.json')], dir)
    if (!status.trim()) return false
    git([
      '-c', `user.name=${actor.name}`,
      '-c', `user.email=${actor.email}`,
      'commit',
      `--author=${actor.name} <${actor.email}>`,
      '-m', message,
      '--', TASK_DOC_FILENAME, join('.tlda', 'parts.json'),
    ], dir)
    return true
  } catch (e) {
    logger.warn?.(`[task-doc] git writeback skipped in ${dir}: ${e.message}`)
    return false
  }
}

function actorFromChanges(changes, agentById) {
  for (const change of changes) {
    const id = change.actor || change.agent || change.task?.agent
    const agent = id ? agentById.get(id) : null
    if (id || agent) {
      return {
        name: agent?.friendly_name || id || 'tlda task materializer',
        email: id || 'task-doc@tlda.local',
      }
    }
  }
  return { name: 'tlda task materializer', email: 'task-doc@tlda.local' }
}

function describeChanges(changes) {
  const normalized = [...changes].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
  if (!normalized.length) return 'task-doc: refresh task projection'
  const first = normalized[0]
  const subject = first.task?.description || first.description || first.taskId || 'task'
  if (normalized.length === 1) return `task-doc: ${first.type || 'update'} "${truncate(subject, 72)}"`
  return `task-doc: materialize ${normalized.length} task changes`
}

function formatBlockers(task) {
  return Array.isArray(task.blockedBy) && task.blockedBy.length ? task.blockedBy.join(', ') : ''
}

function formatLinks(task) {
  const links = []
  if (task.message && task.message !== task.description) links.push('message')
  if (task.success_criteria?.length) links.push('criteria')
  if (task.ownerCwd) links.push(`cwd:${task.ownerCwd}`)
  return links.join('<br>')
}

function compareTasksChronologically(a, b) {
  return String(a.delegated_at || '').localeCompare(String(b.delegated_at || '')) || String(a.id).localeCompare(String(b.id))
}

function isCurrentTask(task) {
  return task.status !== 'done' && task.status !== 'deleted'
}

function compareTasksForDoc(a, b) {
  const statusDelta = statusRank(a.status) - statusRank(b.status)
  if (statusDelta) return statusDelta
  return compareTasksChronologically(a, b)
}

function compareTasksByModified(a, b) {
  const modifiedDelta = String(taskModifiedAt(b)).localeCompare(String(taskModifiedAt(a)))
  if (modifiedDelta) return modifiedDelta
  return compareTasksChronologically(a, b)
}

function taskModifiedAt(task) {
  return task.updated_at || task.completed_at || task.last_checked || task.delegated_at || ''
}

function statusRank(status) {
  const idx = STATUS_ORDER.indexOf(status)
  return idx >= 0 ? idx : STATUS_ORDER.length
}

function tableCell(value) {
  return escapeMarkdown(String(value ?? '').replace(/\r?\n/g, '<br>'))
}

function formatTaskTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/\|/g, '\\|').trim()
}

function writeIfChanged(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true })
  if (existsSync(filePath) && readFileSync(filePath, 'utf8') === content) return false
  writeFileSync(filePath, content)
  return true
}

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitTopLevel(cwd) {
  try {
    return runGit(['rev-parse', '--show-toplevel'], cwd)
  } catch {
    return null
  }
}

function isGitRepo(dir) {
  try {
    runGit(['rev-parse', '--is-inside-work-tree'], dir)
    return true
  } catch {
    return false
  }
}

function safeRealpath(path) {
  try {
    if (!path) return null
    return realpathSync(path)
  } catch {
    return null
  }
}

function isSameOrInside(child, parent) {
  if (!child || !parent) return false
  const a = resolve(child)
  const b = resolve(parent)
  return a === b || a.startsWith(`${b}${sep}`)
}

function expandHome(path) {
  if (!path) return path
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function truncate(value, max) {
  const s = String(value ?? '')
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`
}
