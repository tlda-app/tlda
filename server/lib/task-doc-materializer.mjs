import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

import { CONFIG_DIR } from '../../shared/config.mjs'
import { readDaemonConfig } from '../../agent-launch/permission-ledger.mjs'
import { createProjectPartRecord } from '../../shared/project-parts.mjs'
import { listProjects, projectPartsRoot } from './project-store.mjs'
import { readProjectPartsManifest, upsertProjectPartsManifest } from './project-parts-scanner.mjs'
import {
  checkpointProjectPartWriteback,
  mergeWritebackMetadata,
} from './project-part-writeback.mjs'

export const TASK_DOC_FILENAME = 'TASKS.md'
export const TASK_DOC_KIND = 'task-doc'
export const TASK_DOC_PROJECT_ID = '11111111-1111-4111-8111-111111111111'
export const TASK_DOC_GLOBAL_ID = '22222222-2222-4222-8222-222222222222'
export const DEFAULT_TASK_DOC_DEBOUNCE_MS = 1500
export const STATUS_TASK_DOC_ROW_LIMIT = 100

const STATUS_ORDER = ['blocked', 'pending', 'working', 'idle']
const DEFAULT_GLOBAL_DIR = join(CONFIG_DIR, 'fleet-task-doc')

export function createTaskDocMaterializer({
  fleetStore,
  debounceMs = DEFAULT_TASK_DOC_DEBOUNCE_MS,
  globalDir = resolveTaskDocGlobalDir(),
  projectsProvider = listProjects,
  writebackOptions = {},
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
      const result = materializeTaskDocs({ fleetStore, changes, globalDir, projectsProvider, writebackOptions, logger, git })
      if (!result.ok) {
        logger.warn?.(`[task-doc] ${result.failures.length} writeback(s) did not land`)
      }
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
  writebackOptions = {},
  projectNames = null,
  globalProjectNames = [],
  writeGlobal = true,
  useProjectPartsRoot = false,
  taskRows = null,
  taskTotal = null,
  logger = console,
  git = runGit,
} = {}) {
  const projectNameSet = projectNames == null
    ? null
    : new Set((Array.isArray(projectNames) ? projectNames : [projectNames]).map(name => String(name)).filter(Boolean))
  const globalProjectNameSet = new Set((Array.isArray(globalProjectNames) ? globalProjectNames : [globalProjectNames]).map(name => String(name)).filter(Boolean))
  const rawTasks = Array.isArray(taskRows) ? taskRows : (fleetStore.getActiveTasks?.() || [])
  const agentIds = new Set()
  for (const task of rawTasks) {
    if (task?.agent) agentIds.add(task.agent)
    if (task?.delegated_by) agentIds.add(task.delegated_by)
  }
  for (const change of changes) {
    if (change?.task?.agent) agentIds.add(change.task.agent)
    if (change?.task?.delegated_by) agentIds.add(change.task.delegated_by)
  }
  const agents = typeof fleetStore.getAgentsByIds === 'function'
    ? fleetStore.getAgentsByIds([...agentIds])
    : (Array.isArray(fleetStore.getAllAgents?.()) ? fleetStore.getAllAgents() : [])
  const agentById = new Map(agents.map(agent => [agent.id, agent]))
  const projects = projectsProvider().map(project => ({
    ...project,
    taskDocRoot:
      explicitTaskDocRoot(project) ||
      (useProjectPartsRoot ? safeProjectPartsRoot(project.name) : null) ||
      (project.sourceDir ? resolve(project.sourceDir) : null),
    resolvedRoot: safeRealpath(project.sourceDir || ''),
  })).filter(project =>
    (project.sourceDir || project.taskDocRoot) &&
    (!projectNameSet || projectNameSet.has(project.name))
  )
  const projectMetaByName = new Map(projects.map(project => [project.name, {
    name: project.name,
    taskDocRoot: project.taskDocRoot,
  }]))
  const totalTasks = Number.isFinite(taskTotal) ? taskTotal : rawTasks.length
  const tasks = rawTasks
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
  const writebacks = []

  const projectKeys = new Set([...grouped.projects.keys(), ...changedProjects.keys()])
  if (projectNameSet) {
    for (const project of projects) {
      if (project.taskDocRoot) projectKeys.add(project.name)
    }
  }
  for (const projectKey of [...projectKeys].sort()) {
    const rows = globalProjectNameSet.has(projectKey) ? tasks : (grouped.projects.get(projectKey) || [])
    const project = grouped.projectMeta.get(projectKey) || changedProjects.get(projectKey) || projectMetaByName.get(projectKey)
    if (!project?.taskDocRoot) continue
    const isGlobalProjectDoc = globalProjectNameSet.has(projectKey)
    const writeback = writeTaskDoc({
      filePath: join(project.taskDocRoot, TASK_DOC_FILENAME),
      root: project.taskDocRoot,
      id: TASK_DOC_PROJECT_ID,
      title: `Tasks for ${project.name}`,
      rows,
      heading: `# Tasks for ${project.name}`,
      rowLimit: isGlobalProjectDoc ? rows.length : null,
      rowTotal: isGlobalProjectDoc ? totalTasks : null,
      writebackOptions,
    })
    writeTaskDocManifest(project.taskDocRoot, {
      id: TASK_DOC_PROJECT_ID,
      title: `Tasks for ${project.name}`,
      writeback: writeback.writeback,
    })
    touchedDirs.add(project.taskDocRoot)
    writebacks.push({ ...writeback, root: project.taskDocRoot, scope: 'project', project: project.name })
  }

  if (writeGlobal) {
    mkdirSync(globalDir, { recursive: true })
    const globalWriteback = writeGlobalTaskDoc(globalDir, tasks, { writebackOptions })
    writeTaskDocManifest(globalDir, { id: TASK_DOC_GLOBAL_ID, title: 'Fleet tasks', writeback: globalWriteback.writeback })
    touchedDirs.add(globalDir)
    writebacks.push({ ...globalWriteback, root: globalDir, scope: 'global', project: null })
  }

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

  const failures = writebacks.filter(writeback => !writeback.ok)
  for (const failure of failures) {
    logger.warn?.(`[task-doc] writeback did not land for ${failure.filePath}: ${failure.writeback?.status || 'failed'} ${failure.writeback?.message || ''}`.trim())
  }

  return { ok: failures.length === 0, tasks, taskTotal: totalTasks, touchedDirs: [...touchedDirs], globalDir, writebacks, failures }
}

export function resolveTaskDocGlobalDir(config = readDaemonConfig()) {
  const raw = config.taskDoc?.globalDir || null
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

function safeProjectPartsRoot(name) {
  if (!name) return null
  try {
    return projectPartsRoot(name)
  } catch {
    return null
  }
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

function writeGlobalTaskDoc(root, tasks, { writebackOptions = {} } = {}) {
  const filePath = join(root, TASK_DOC_FILENAME)
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
  return writeIfChanged(filePath, lines.join('\n'), {
    part: () => findExistingPart(root, TASK_DOC_GLOBAL_ID),
    writebackOptions,
  })
}

function writeTaskDoc({ filePath, root, id, title, rows, heading, rowLimit = null, rowTotal = null, writebackOptions = {} }) {
  const boundedNote = Number.isFinite(rowLimit) && Number.isFinite(rowTotal) && rowTotal > rowLimit
    ? [`Showing the ${rowLimit} most recently delegated active tasks of ${rowTotal} total.`, '']
    : []
  const lines = [
    '---',
    `tlda-id: ${id}`,
    `tlda-kind: ${TASK_DOC_KIND}`,
    '---',
    '',
    heading || `# ${title}`,
    '',
    ...boundedNote,
    ...markdownTable(rows),
    '',
  ]
  return writeIfChanged(filePath, lines.join('\n'), {
    part: () => findExistingPart(root, id),
    writebackOptions,
  })
}

function markdownTable(rows, { includeProject = false, sort = compareTasksByModified } = {}) {
  const columns = [
    ...(includeProject ? ['project'] : []),
    'subject',
    'assigned to',
    'delegator',
    'status',
    'created',
    'updated',
    'blockers',
    'details',
  ]
  const ordered = [...rows].sort(sort)
  return [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...ordered.map(task => taskTableRow(task, { includeProject })),
  ]
}

function taskTableRow(task, { includeProject = false } = {}) {
  const selfAssigned = !!task.agent && task.agent === task.delegated_by
  const cells = [
    ...(includeProject ? [task.projectName || 'global'] : []),
    formatTaskSubject(task),
    formatAgentCell(task.ownerName || task.agent, task.agent),
    selfAssigned
      ? formatAgentCell('self-assigned', task.delegated_by)
      : formatAgentCell(task.delegatedByName || task.delegated_by, task.delegated_by),
    task.status || '',
    formatTaskTime(task.delegated_at),
    formatTaskTime(task.updated_at || task.completed_at || task.last_checked || task.delegated_at),
    formatBlockers(task),
    formatLinks(task),
  ]
  return `| ${cells.map(tableCell).join(' | ')} |`
}

function writeTaskDocManifest(root, { id, title, writeback = null }) {
  upsertProjectPartsManifest(root, createProjectPartRecord({
    id,
    kind: TASK_DOC_KIND,
    path: TASK_DOC_FILENAME,
    title,
    storage: { type: 'project', path: TASK_DOC_FILENAME },
    metadata: mergeWritebackMetadata({ managed: true }, writeback),
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
  if (!Array.isArray(task.blockedBy) || !task.blockedBy.length) return ''
  const label = task.blockedBy.length === 1 ? 'blocked by 1 task' : `blocked by ${task.blockedBy.length} tasks`
  return `<span class="task-doc-detail" title="${escapeHtmlAttr(task.blockedBy.join(', '))}">${label}</span>`
}

function formatLinks(task) {
  const details = []
  if (task.message && task.message !== task.description) details.push('message')
  if (task.success_criteria?.length) details.push('success criteria')
  if (!details.length) return ''
  const title = [
    task.success_criteria?.length ? `${task.success_criteria.length} success ${task.success_criteria.length === 1 ? 'criterion' : 'criteria'}` : '',
  ].filter(Boolean).join(' · ')
  return `<span class="task-doc-detail"${title ? ` title="${escapeHtmlAttr(title)}"` : ''}>${details.map(escapeHtml).join(', ')}</span>`
}

function compareTasksChronologically(a, b) {
  return String(a.delegated_at || '').localeCompare(String(b.delegated_at || '')) || String(a.id).localeCompare(String(b.id))
}

function isCurrentTask(task) {
  return task.status !== 'done' && task.status !== 'deleted'
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

function formatTaskSubject(task) {
  const subject = task.description || task.id || ''
  if (!task.id || subject === task.id) return subject
  return `<span class="task-doc-task-subject" title="${escapeHtmlAttr(task.id)}">${escapeHtml(subject)}</span>`
}

function formatAgentCell(label, id) {
  const text = label || id || ''
  if (!text) return ''
  if (id?.startsWith?.('fleet:') && text === id) {
    return `<span class="task-doc-agent task-doc-agent-unknown" title="${escapeHtmlAttr(id)}">unknown agent</span>`
  }
  if (!id || text === id) return escapeHtml(text)
  return `<span class="task-doc-agent" title="${escapeHtmlAttr(id)}">${escapeHtml(text)}</span>`
}

function formatTaskTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const iso = date.toISOString()
  return `<time class="task-doc-time" datetime="${escapeHtmlAttr(iso)}" title="${escapeHtmlAttr(iso.replace('T', ' ').replace('.000Z', ' UTC'))}">${escapeHtml(iso.slice(0, 10))}</time>`
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/\|/g, '\\|').trim()
}

function findExistingPart(root, id) {
  return readProjectPartsManifest(root).parts.find(part => part.id === id) || null
}

function writeIfChanged(filePath, content, { part = null, writebackOptions = {}, maxRetries = 1 } = {}) {
  let lastResult = null
  let attempts = 0
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1
    const currentPart = typeof part === 'function' ? part() : part
    const result = checkpointProjectPartWriteback({ filePath, content, part: currentPart, ...writebackOptions })
    lastResult = result
    if (result.ok) {
      return { ok: true, filePath, attempts: attempt + 1, writeback: result.writeback }
    }
    if (!canRetryWriteback(result)) break
  }
  return { ok: false, filePath, attempts, writeback: lastResult?.writeback || null }
}

function canRetryWriteback(result) {
  return result?.status === 'failed'
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeHtmlAttr(value) {
  return escapeHtml(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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
