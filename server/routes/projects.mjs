/**
 * Project API routes.
 *
 * Mounted at /api/projects in the unified server.
 *
 * Endpoints:
 *   POST   /                    Create project
 *   GET    /                    List projects
 *   GET    /:name               Project info
 *   DELETE /:name               Remove project
 *   GET    /:name/files         List source files
 *   GET    /:name/source/:file  Read source file content
 *   PUT    /:name/source/:file  Write source file content and trigger build
 *   POST   /:name/push          Push files + trigger build
 *   POST   /:name/build         Trigger rebuild
 *   GET    /:name/build/status  Build status + log
 */

import { Router } from 'express'
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { access, mkdir, readFile, readdir, rm, unlink, writeFile } from 'fs/promises'
import { join, dirname, resolve } from 'path'
import { promisify } from 'util'
import { requireRead, requireRw } from '../lib/auth.mjs'
import {
  createProject, readProject, updateProject, listProjects, deleteProject,
  readProjectMeta,
  listSourceFiles, hashSourceFiles, readSourceFileAsync, writeSourceFileAsync, deleteSourceFileAsync, readBuildLogAsync, sourceDir as getSourceDir, outputDir as getOutputDir,
  extractBuildErrors, extractPipelineWarningsAsync, addBookMember, getProjectsDir, projectDir as getProjectDir,
  projectPartsRoot, readProjectPartsManifest, writeProjectPartsManifest,
  listDocumentAssociations,
  isClientOwnedSourcePath, readClientSourceManifest, validateSourceFilePath,
  beginProjectSourceTransaction,
  updateClientSourceManifest,
  sourceLifecycleStore,
  checkpointProjectPartWritebackOffloop,
} from '../lib/project-store.mjs'
import { changedTextRegions } from '../lib/changed-text-regions.mjs'
import { emitSourceEditEvent } from '../lib/source-edit-event.mjs'
import { recordAcceptedSourceTransaction } from '../lib/edit-events.mjs'
import { getBuildStatus } from '../lib/build-runner.mjs'
import { dispatchBuild, isBuildKindPending } from '../lib/build-dispatch.mjs'
import { outlineForRegion, regionFromSpan, structuralLeaves } from '../lib/outline/outline.mjs'
import { buildModel, assertRoundTrip } from '../lib/outline/model.mjs'
import { findTextNearSourceLine, sourceTextSpanToPdfSpans } from '../lib/synctex-query.mjs'
import { compareHighlightFeedbackBySource, highlightFeedbackFromShape } from '../lib/highlight-feedback.mjs'
import { realizeProjectMarkdownArtifact, writeProjectMarkdownArtifact } from '../lib/project-artifact-materializer.mjs'
import { TASK_DOC_FILENAME, TASK_DOC_PROJECT_ID, STATUS_TASK_DOC_ROW_LIMIT, materializeTaskDocs } from '../lib/task-doc-materializer.mjs'
import { markdownColumnFileForSource, listProjectPartColumns, pageInfoFromDocumentColumns } from '../lib/document-columns.mjs'
import { shouldBuildOnPush } from '../lib/build-decision.mjs'
import { isSourceFilePath, normalizeSourceManifest, sourceManifestContext } from '../../shared/source-manifest.mjs'
import historyRoutes from './history.mjs'
import { linkOverleaf, unlinkOverleaf, syncOverleaf, prepareSourcePushToOverleaf, recoverProjectSourceTransactions, readOverleafLocalHead, stopPolling, isPolling } from '../lib/overleaf-sync.mjs'
import { getRoomRecords, getRecord, putShape, updateShape, deleteShape, onShapeChange, getOrCreateRoom, broadcastSignal, getLastSignal, onSignal, replaceRoomSnapshot, getShapesAt, emitGlobalEvent, onGlobalEvent } from '../lib/sync-rooms.mjs'
import { getFleetServerUrl, getServerUrl } from '../../shared/config.mjs'
import { FORMATS_WITH_OWN_PAGE_INFO } from '../../shared/document-formats.mjs'
import { readSharedDocumentThroughOwner } from '../lib/document-association-sources.mjs'
import { readShadowChangelog, readShadowIndexInfo } from '../lib/shadow-changelog.mjs'

const router = Router()
const execFileAsync = promisify(execFile)

function execFileWithInput(file, args, input, options) {
  const execution = execFileAsync(file, args, options)
  execution.child.stdin.end(input)
  return execution
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = {}
  let nextIndex = 0
  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++]
      results[item] = await mapper(item)
    }
  }))
  return results
}

// Formats that already write their own page-info.json via their own build
// pipeline (server/lib/format-builders.mjs) — writing a parts-only one would
// clobber it. Everything else (svg, png, diff, ...) has no page-info.json of
// its own, so a project's parts get one. The viewer needs the same fact to
// know whether a page-info.json it fetches is parts or the document's own
// pages, so the set lives in shared/ rather than here.

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return a === b
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return res.json()
}

async function fetchFleetPages(fleetServer, path, field, { limit = 200, stopAfterFirst = false } = {}) {
  const rows = []
  let cursor = null
  let nextCursor = null
  let total = 0
  do {
    const url = new URL(path, fleetServer)
    url.searchParams.set('limit', String(limit))
    if (cursor) url.searchParams.set('cursor', cursor)
    const page = await fetchJson(url.toString())
    rows.push(...(Array.isArray(page?.[field]) ? page[field] : []))
    total = Number.isFinite(page?.total) ? page.total : rows.length
    nextCursor = page?.nextCursor || null
    cursor = stopAfterFirst ? null : nextCursor
  } while (cursor)
  return { rows, total, nextCursor }
}

async function taskDocFleetSource(localFleetStore, { boundedTasksLimit = null } = {}) {
  const fleetServer = getFleetServerUrl()
  const storeServer = getServerUrl()
  if (sameOrigin(fleetServer, storeServer)) return localFleetStore

  const taskPage = await fetchFleetPages(fleetServer, '/api/tasks', 'tasks', {
    limit: Number.isFinite(boundedTasksLimit) ? boundedTasksLimit : 200,
    stopAfterFirst: Number.isFinite(boundedTasksLimit),
  })
  const tasks = taskPage.rows
  const taskTotal = taskPage.total
  const nextCursor = taskPage.nextCursor
  return {
    async getAgentsByIds(ids) {
      const agents = []
      for (let i = 0; i < ids.length; i += 200) {
        const url = new URL('/api/agents/lookup', fleetServer)
        url.searchParams.set('ids', ids.slice(i, i + 200).join(','))
        const payload = await fetchJson(url.toString())
        agents.push(...(payload.agents || []))
      }
      return agents
    },
    getActiveTasks() {
      return tasks
    },
    ...(Number.isFinite(boundedTasksLimit)
      ? {
          getActiveTasksPage() {
            return { tasks, nextCursor }
          },
          getActiveTaskCount() {
            return taskTotal
          },
        }
      : {}),
  }
}

// Mount history sub-router
router.use('/:name/history', historyRoutes)

// List all projects
router.get('/', requireRead, async (req, res) => {
  res.json({ projects: await listProjects() })
})

router.post('/:name/document-associations', requireRead, async (req, res) => {
  const requested = Array.isArray(req.body?.documents) ? req.body.documents : []
  const documents = []
  for (const document of requested) {
    if (document?.kind !== 'shared') {
      documents.push(document)
      continue
    }
    try {
      const result = await readSharedDocumentThroughOwner({
        fleetStore: req.app.locals.fleetStore,
        sendDaemonEphemeral: req.app.locals.sendDaemonEphemeral,
        document,
      })
      documents.push({ ...document, text: result.text })
    } catch (error) {
      return res.status(error.code === 'NO_ROUTE' ? 409 : error.code === 'NO_DAEMON' ? 503 : 502).json({ error: error.message })
    }
  }
  try {
    res.json({ associations: await listDocumentAssociations(req.params.name, documents) })
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

router.get('/meta', requireRead, async (req, res) => {
  res.json(await readProjectMeta())
})

// Space-time changelogs for an explicit page of project rows.
router.post('/history/shadow/changelog/batch', requireRead, async (req, res) => {
  const names = [...new Set(
    (Array.isArray(req.body?.projects) ? req.body.projects : [])
      .filter(name => typeof name === 'string' && name.length > 0),
  )]
  if (names.length === 0) return res.json({ projects: {} })
  if (names.length > 50) {
    return res.status(400).json({ error: 'At most 50 projects may be requested at once' })
  }

  const projects = await mapWithConcurrency(names, 4, async name => {
    try {
      return await readShadowChangelog(name, { limit: null })
    } catch (error) {
      return { commits: [], totalPages: 0, error: error.message }
    }
  })
  res.json({ projects })
})

// Select real project histories and establish the shared clock before any row
// strips render. A synthetic init or one build does not qualify as history.
router.post('/history/shadow/index', requireRead, async (req, res) => {
  const names = [...new Set(
    (Array.isArray(req.body?.projects) ? req.body.projects : [])
      .filter(name => typeof name === 'string' && name.length > 0),
  )]
  if (names.length === 0) return res.json({ projects: {}, oldest: null })
  if (names.length > 500) {
    return res.status(400).json({ error: 'At most 500 projects may be requested at once' })
  }

  const errors = {}
  const scanned = await mapWithConcurrency(names, 8, async name => {
    try {
      return await readShadowIndexInfo(name)
    } catch (error) {
      errors[name] = error.message
      return null
    }
  })
  const projects = Object.fromEntries(
    Object.entries(scanned).filter(([, info]) => info !== null),
  )
  const histories = Object.values(projects)
  res.json({
    projects,
    oldest: histories.length > 0
      ? Math.min(...histories.map(info => info.oldest.timestamp))
      : null,
    errors,
  })
})

// GET /health — check sync health for all docs that have a snapshot
router.get('/health', requireRead, async (req, res) => {
  const health = {}
  const dir = getProjectsDir()
  for (const project of await listProjects()) {
    const snapPath = join(dir, project.name, 'sync-snapshot.json')
    if (!await pathExists(snapPath)) continue
    try {
      const room = await getOrCreateRoom(syncRoomName(project.name))
      const snapshot = room.getCurrentSnapshot()
      const shapes = snapshot.documents?.filter(d => d.state?.typeName === 'shape').length || 0
      health[project.name] = { ok: true, shapes }
    } catch (e) {
      health[project.name] = { ok: false, error: e.message }
    }
  }
  res.json(health)
})

// GET /events/stream — Global SSE stream of project-level events (doc-arrived, etc.)
router.get('/events/stream', requireRead, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })
  res.write('data: {"type":"connected"}\n\n')

  const keepalive = setInterval(() => res.write(':\n\n'), 15000)

  const unsub = onGlobalEvent((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  })

  req.on('close', () => {
    clearInterval(keepalive)
    unsub()
  })
})

// List archived projects
router.get('/archived', requireRead, async (req, res) => {
  const projects = (await listProjects()).filter(p => p.archived)
  res.json({ projects })
})

// Create project
router.post('/', requireRw, async (req, res) => {
  try {
    const { name, title, mainFile, format, members } = req.body
    if (!name) return res.status(400).json({ error: 'name is required' })
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return res.status(400).json({ error: 'name must be lowercase alphanumeric with hyphens' })
    }
    if (format === 'book' && (!members || !Array.isArray(members) || members.length === 0)) {
      return res.status(400).json({ error: 'book format requires a non-empty members array' })
    }
    const project = createProject({ name, title, mainFile, format, members })
    emitGlobalEvent('project-changed', { name: project.name })
    res.status(201).json(project)
  } catch (e) {
    res.status(409).json({ error: e.message })
  }
})

// Get project
router.get('/:name', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const activeBuild = getBuildStatus(req.params.name)
  res.json({
    ...project,
    ...(activeBuild?.building && { activeBuild }),
  })
})

// Materialize shared/embedded markdown as a real, synced column of this project
// (not a separate project, not a temp snapshot) — the same manifest/rebuild
// pipeline that already backs project parts/notes.
router.post('/:name/parts', requireRw, async (req, res) => {
  try {
    const result = await realizeProjectMarkdownArtifact({
      project: req.params.name,
      markdown: req.body?.markdown,
      sourcePath: req.body?.sourcePath,
      title: req.body?.title,
      actor: req.body?.actor,
      provenance: req.body?.provenance,
    })
    if (!result.ready) {
      const status = result.status === 'not materialized' && /no project resolved/i.test(result.error || '') ? 404 : 400
      return res.status(status).json({ ok: false, error: result.error, ...result })
    }
    const project = await readProject(req.params.name)
    if (project?.format === 'markdown') {
      await dispatchBuild(req.params.name)
    } else if (!FORMATS_WITH_OWN_PAGE_INFO.has(project?.format)) {
      // svg/png/diff and any other format with no page-info.json of its own —
      // write the parts-only manifest and tell open viewers to reload.
      // (html/slides own page-info.json via their own build pipeline; wiring
      // parts into those is a separate, unstarted piece.)
      await dispatchBuild(req.params.name, { kind: 'parts' })
    }
    emitGlobalEvent('project-changed', { name: req.params.name })
    res.json({ ok: true, ...result, outputFile: markdownColumnFileForSource(result.projectPath) })
  } catch (e) {
    const message = e?.message || String(e)
    res.status(500).json({ ok: false, error: message })
  }
})

// Markdown-part columns for a project whose own main document is NOT
// markdown — e.g. the scratch/notes parts on a LaTeX/svg project. Any
// project format can have parts; each part always renders through the
// markdown renderer regardless of the parent project's own format.
router.get('/:name/parts', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  const columns = await listProjectPartColumns(req.params.name)
  res.json(pageInfoFromDocumentColumns(req.params.name, columns))
})

// Refresh the managed task document as a first-class project part. Unlike the
// generic markdown artifact route, this preserves tlda-kind: task-doc so the
// markdown renderer installs the task controls.
router.post('/:name/task-doc/refresh', requireRw, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  const fleetStore = req.app?.locals?.fleetStore
  if (!fleetStore) return res.status(503).json({ ok: false, error: 'Fleet store not available' })

  try {
    const isStatusDoc = req.params.name === 'status'
    const sourceFleetStore = await taskDocFleetSource(fleetStore, {
      boundedTasksLimit: isStatusDoc ? STATUS_TASK_DOC_ROW_LIMIT : null,
    })
    const page = isStatusDoc && typeof sourceFleetStore.getActiveTasksPage === 'function'
      ? sourceFleetStore.getActiveTasksPage({ limit: STATUS_TASK_DOC_ROW_LIMIT })
      : null
    const taskTotal = isStatusDoc && typeof sourceFleetStore.getActiveTaskCount === 'function'
      ? sourceFleetStore.getActiveTaskCount()
      : null
    const result = await materializeTaskDocs({
      fleetStore: sourceFleetStore,
      projectNames: [req.params.name],
      globalProjectNames: isStatusDoc ? [req.params.name] : [],
      taskRows: page?.tasks || null,
      taskTotal,
      useProjectPartsRoot: true,
      writeGlobal: false,
      changes: [{ type: 'refresh', description: `refresh task doc for ${req.params.name}` }],
      checkpoint: checkpointProjectPartWritebackOffloop,
    })
    const touched = result.touchedDirs?.includes(projectPartsRoot(req.params.name)) || false
    if (project.format === 'markdown') {
      await dispatchBuild(req.params.name)
    } else if (!FORMATS_WITH_OWN_PAGE_INFO.has(project.format)) {
      await dispatchBuild(req.params.name, { kind: 'parts' })
    }
    emitGlobalEvent('project-changed', { name: req.params.name })
    res.json({
      ok: true,
      project: req.params.name,
      touched,
      taskCount: isStatusDoc
        ? result.taskTotal
        : result.tasks.filter(task => task.projectName === req.params.name).length,
      part: {
        id: TASK_DOC_PROJECT_ID,
        kind: 'task-doc',
        path: TASK_DOC_FILENAME,
        outputFile: markdownColumnFileForSource(TASK_DOC_FILENAME),
      },
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
})

// Remove a project part (its file + manifest entry) and tell open viewers to
// reload so the removed column disappears from the canvas.
router.delete('/:name/parts/:id', requireRw, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  const root = projectPartsRoot(req.params.name)
  const manifest = await readProjectPartsManifest(req.params.name)
  const part = manifest.parts.find(p => p.id === req.params.id)
  if (!part) return res.status(404).json({ error: 'Part not found' })
  const targetPath = String(part.path || part.storage?.path || '')
  if (targetPath && !targetPath.startsWith('/') && !targetPath.split('/').includes('..')) {
    const localPath = join(root, targetPath)
    if (await pathExists(localPath)) await rm(localPath)
  }
  await writeProjectPartsManifest(req.params.name, {
    ...manifest,
    parts: manifest.parts.filter(p => p.id !== req.params.id),
  })
  if (project.format === 'markdown') {
    await dispatchBuild(req.params.name)
  } else if (!FORMATS_WITH_OWN_PAGE_INFO.has(project.format)) {
    await dispatchBuild(req.params.name, { kind: 'parts' })
  }
  res.json({ ok: true, deleted: req.params.id })
})

// Read a project-owned markdown artifact part. With ?version=<git hash>, reads
// the immutable bytes from that project source repo version instead of the
// current overwritten file.
router.get('/:name/parts/:partId/markdown', requireRead, async (req, res) => {
  try {
    const project = await readProject(req.params.name)
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' })
    const root = projectPartsRoot(req.params.name)
    const manifest = await readProjectPartsManifest(req.params.name)
    const part = manifest.parts.find(p => p.id === req.params.partId)
    if (!part) return res.status(404).json({ ok: false, error: 'Part not found' })
    const targetPath = String(part.path || part.storage?.path || '')
    if (!targetPath || targetPath.startsWith('/') || targetPath.split('/').includes('..')) {
      return res.status(400).json({ ok: false, error: 'Project part has invalid path' })
    }

    const version = typeof req.query.version === 'string' ? req.query.version.trim() : ''
    let markdown
    if (version) {
      if (!/^[0-9a-f]{7,40}$/i.test(version)) {
        return res.status(400).json({ ok: false, error: 'Invalid project part version' })
      }
      ;({ stdout: markdown } = await execFileAsync('git', ['show', `${version}:${targetPath}`], {
        cwd: root,
        encoding: 'utf8',
      }))
    } else {
      markdown = await readFile(join(root, targetPath), 'utf8')
    }

    res.type('text/markdown').send(markdown)
  } catch (e) {
    const message = e?.message || String(e)
    const status = /not found|exists on disk|Path .* does not exist/i.test(message) ? 404 : 500
    res.status(status).json({ ok: false, error: message })
  }
})

// Write back a project-owned markdown artifact part.
router.put('/:name/parts/:partId/markdown', requireRw, async (req, res) => {
  try {
    const result = await writeProjectMarkdownArtifact({
      project: req.params.name,
      projectArtifactId: req.params.partId,
      markdown: req.body?.markdown,
      title: req.body?.title,
      actor: req.body?.actor,
      provenance: req.body?.provenance,
    })
    const project = await readProject(req.params.name)
    if (project?.format === 'markdown') {
      await dispatchBuild(req.params.name)
      emitGlobalEvent('project-changed', { name: req.params.name })
    } else if (!FORMATS_WITH_OWN_PAGE_INFO.has(project?.format)) {
      await dispatchBuild(req.params.name, { kind: 'parts' })
      emitGlobalEvent('project-changed', { name: req.params.name })
    }
    res.json({ ok: true, ...result })
  } catch (e) {
    const message = e?.message || String(e)
    const status = /not found|not in the parts manifest|missing/i.test(message) ? 404 : /requires|invalid|mismatch|not an artifact/i.test(message) ? 400 : 500
    res.status(status).json({ ok: false, error: message })
  }
})

// Archive/unarchive project
router.patch('/:name/archive', requireRw, async (req, res) => {
  try {
    const { archived } = req.body
    const project = await updateProject(req.params.name, { archived: !!archived })
    res.json({ ok: true, archived: project.archived })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

router.patch('/:name/star', requireRw, async (req, res) => {
  try {
    const { starred } = req.body
    const updates = { starred: !!starred }
    if (updates.starred) updates.archived = false
    const project = await updateProject(req.params.name, updates)
    res.json({ ok: true, starred: project.starred, archived: project.archived })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

// Toggle autoSync (git mirror sync)
router.patch('/:name/auto-sync', requireRw, async (req, res) => {
  try {
    const { autoSync } = req.body
    const project = await updateProject(req.params.name, { autoSync: !!autoSync })
    res.json({ ok: true, autoSync: project.autoSync })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

// Link a Git remote → clone, initial sync, start polling.
// Body: { source, token?, title?, mainFile?, format?, pollSeconds? }
router.post('/:name/link', requireRw, async (req, res) => {
  try {
    const { source, token, title, mainFile, format, pollSeconds } = req.body || {}
    if (!source) return res.status(400).json({ error: 'source is required' })
    if (!/^[a-z0-9][a-z0-9-]*$/.test(req.params.name)) {
      return res.status(400).json({ error: 'name must be lowercase alphanumeric with hyphens' })
    }
    const result = await linkOverleaf(req.params.name, { gitUrl: source, token, title, mainFile, format, pollSeconds })
    if (result.linked) {
      const project = await readProject(req.params.name)
      if (project?.format === 'svg') {
        await dispatchBuild(req.params.name)
      }
      emitGlobalEvent('project-changed', { name: req.params.name })
    }
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Manually trigger one Overleaf sync (also serves as a webhook endpoint).
router.post('/:name/overleaf-sync', requireRw, async (req, res) => {
  try {
    const result = await syncOverleaf(req.params.name)
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Unlink the exact Git remote (stops polling, removes the clone; keeps the project).
router.post('/:name/unlink', requireRw, async (req, res) => {
  try {
    const { source } = req.body || {}
    if (!source) return res.status(400).json({ error: 'source is required' })
    const result = await unlinkOverleaf(req.params.name, { gitUrl: source })
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Delete project
router.delete('/:name', requireRw, async (req, res) => {
  try {
    stopPolling(req.params.name)
    await deleteProject(req.params.name)
    res.json({ ok: true })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

// Add member to book (create book project if needed)
router.patch('/:name/members', requireRw, async (req, res) => {
  const { add } = req.body
  if (!add || typeof add !== 'string') return res.status(400).json({ error: 'add member name required' })
  try {
    const book = await addBookMember(req.params.name, add)
    res.json({ ok: true, members: book.members })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// List source files
router.get('/:name/files', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  res.json({ files: await listSourceFiles(req.params.name) })
})

router.get('/:name/source-authority', requireRead, async (req, res) => {
  try { res.json((await sourceLifecycleStore(req.params.name)).readAuthority()) }
  catch (e) { res.status(404).json({ error: e.message }) }
})

// Read a specific source file's content
router.get('/:name/source/:file', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  try {
    const current = (await sourceLifecycleStore(req.params.name)).readCurrentFile(req.params.file)
    if (current) {
      if (current.content === null) return res.status(404).json({ error: 'File not found' })
      res.set('X-TLDA-Source-Revision', current.sourceRevision)
      return res.set('Content-Type', 'text/plain; charset=utf-8').send(current.content)
    }
    const content = await readSourceFileAsync(req.params.name, req.params.file)
    if (content === null) return res.status(404).json({ error: 'File not found' })
    res.set('Content-Type', 'text/plain; charset=utf-8').send(content)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Write a specific source file's content and trigger the normal project push path
router.put('/:name/source/:file', requireRw, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  const content = typeof req.body?.content === 'string' ? req.body.content : null
  if (content === null) return res.status(400).json({ error: 'Required: content string' })
  const result = await processProjectPush(req.params.name, {
    files: [{ path: req.params.file, content }],
    sourceManifest: req.body?.sourceManifest,
    editedBy: req.body?.editedBy,
    expectedRevision: req.body?.expectedRevision,
  })
  const { status, lifecycleStatus, ...payload } = result
  res.status(status).json({ ...payload, ...(lifecycleStatus ? { status: lifecycleStatus } : {}) })
})

// Synctex path-based lookup: trace highlight path through synctex records
router.post('/:name/synctex-path', requireRead, async (req, res) => {
  const { getSourceFromPath } = await import('../lib/synctex-query.mjs')
  const { page, points, text, fragments, target } = req.body
  if (!page || !points?.length) {
    return res.status(400).json({ error: 'Required: page, points[]' })
  }
  try {
    // For multi-target projects, convert global page to local page within the target
    let localPage = page
    let resolvedTarget = target || ''
    if (!resolvedTarget) {
      // Client didn't send target — compute from project metadata
      const project = await readProject(req.params.name)
      if (project?.targets?.length > 1) {
        let offset = 0
        for (const t of project.targets) {
          if (page <= offset + t.pages) { resolvedTarget = t.texBase; break }
          offset += t.pages
        }
      }
    }
    if (resolvedTarget) {
      const project = await readProject(req.params.name)
      let offset = 0
      for (const t of (project?.targets || [])) {
        if (t.texBase === resolvedTarget) break
        offset += t.pages
      }
      localPage = page - offset
    }
    const result = await getSourceFromPath(req.params.name, localPage, points, text || '', fragments || [], resolvedTarget)
    if (!result) return res.status(404).json({ error: 'No synctex data or no match' })
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Preamble macros (KaTeX-compatible, parsed during build from main tex file).
// Outputs are now per-target — fetch the primary target's macros.
router.get('/:name/macros', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.json({ macros: {} })
  const texBase = (project.mainFile || 'main.tex').replace(/\.tex$/, '').split('/').pop()
  const outputPath = join(getOutputDir(req.params.name), `${texBase}-macros.json`)
  if (!await pathExists(outputPath)) return res.json({ macros: {} })
  try {
    const data = JSON.parse(await readFile(outputPath, 'utf8'))
    res.json({ macros: data.macros || {} })
  } catch {
    res.json({ macros: {} })
  }
})

// Clause-grain outline of a word-precise source span — drives the "outline"
// highlighter. The span is (startLine,startCol)→(endLine,endCol), 1-indexed
// lines / 0-indexed cols, collapsed to whole words server-side. Lines are only
// a coordinate; the outline covers exactly the first-word→last-word substring.
// GET /:name/outline?startLine&startCol&endLine&endCol[&file=path.tex]
//   -> { markdown, span, file }
router.get('/:name/outline', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  const startLine = parseInt(req.query.startLine, 10)
  const startCol = parseInt(req.query.startCol, 10)
  const endLine = parseInt(req.query.endLine, 10)
  const endCol = parseInt(req.query.endCol, 10)
  if (![startLine, startCol, endLine, endCol].every(Number.isFinite)) {
    return res.status(400).json({ error: 'startLine, startCol, endLine, endCol required' })
  }
  const file = String(req.query.file || project.mainFile || 'main.tex')
  const texPath = join(getSourceDir(req.params.name), file)
  if (!await pathExists(texPath)) return res.status(404).json({ error: `tex not found: ${file}` })
  const text = await readFile(texPath, 'utf8')
  const region = regionFromSpan(text, startLine, startCol, endLine, endCol)
  const base = String(file).replace(/\.tex$/, '').split('/').pop()
  const slug = `${base}-L${startLine}c${startCol}-L${endLine}c${endCol}`
  try {
    // Best-effort clause outline; if the span yields nothing, fall back to the
    // raw highlighted text so the extracted note is never empty.
    let markdown = outlineForRegion(region)
    if (!markdown || !markdown.trim()) markdown = region
    // Persist the frozen-token model for the argument-chain artifact. This is
    // the FRAGILE step: structuralLeaves must be an EXACT partition of the
    // region, which fails for some LaTeX and used to throw a 500 here — so
    // extraction silently produced no note at all. Degrade gracefully.
    let modelOk = false
    try {
      const model = buildModel(region, structuralLeaves(region))
      assertRoundTrip(model, region)
      model.regionFile = file
      model.span = { startLine, startCol, endLine, endCol }
      const modelDir = join(getOutputDir(req.params.name), 'outlines')
      await mkdir(modelDir, { recursive: true })
      await writeFile(join(modelDir, `${slug}.model.json`), JSON.stringify(model), 'utf8')
      modelOk = true
    } catch (modelErr) {
      console.warn(`[outline] token model unavailable for ${slug} (${String(modelErr?.message || modelErr)}); returning plain note`)
    }
    // Companion tex / md views so the note can offer the tex/md/outline switch.
    // tex is the raw region; md is its pandoc conversion (raw tex on failure).
    const tex = region
    let mdView = region
    try {
      ;({ stdout: mdView } = await execFileWithInput(
        'pandoc',
        ['-f', 'latex', '-t', 'markdown', '--wrap=none'],
        region,
        { encoding: 'utf8', timeout: 10000 },
      ))
    } catch { /* pandoc unavailable — fall back to raw tex */ }
    res.json({ markdown, tex, md: mdView, span: { startLine, startCol, endLine, endCol }, file, slug: modelOk ? slug : '' })
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) })
  }
})

// Source file hashes (for incremental push)
router.get('/:name/hashes', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  res.json({ hashes: await hashSourceFiles(req.params.name) })
})

/**
 * Apply a project source push and trigger the build pipeline.
 *
 * Shared between the HTTP /api/projects/:name/push route and the
 * fleet-daemon WS `source-change` handler in unified-server.mjs. The
 * daemon owns local source watching but the build runs on the server.
 *
 * Returns { ok, filesWritten, building, unchanged?, error?, status }
 * where `status` is the HTTP status the caller should send (200 / 404).
 *
 * Building runs async — the function awaits any sync work and returns
 * once it has decided whether a build should run; build completion
 * happens in the background.
 */
const sourcePushQueues = new Map()

function withAcceptedChangedFiles(result, files) {
  Object.defineProperty(result, 'acceptedChangedFiles', { value: files })
  return result
}

function withAcceptedSourceMutation(result, mutation) {
  if (mutation) Object.defineProperty(result, 'acceptedSourceMutation', { value: mutation })
  return result
}

let acceptedSourceMutationHandler = null

export function setAcceptedSourceMutationHandler(handler) {
  acceptedSourceMutationHandler = typeof handler === 'function' ? handler : null
}

export async function runSerializedProjectSourceOperation(name, operation) {
  const previous = sourcePushQueues.get(name) || Promise.resolve()
  let release
  const current = new Promise(resolve => { release = resolve })
  sourcePushQueues.set(name, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (sourcePushQueues.get(name) === current) sourcePushQueues.delete(name)
  }
}

export async function processProjectPush(name, body, transactionTest = {}) {
  const result = await runSerializedProjectSourceOperation(
    name,
    () => processProjectPushSerialized(name, body, transactionTest),
  )
  if (result.ok && (((body?.files?.length || 0) > 0) || ((body?.deletedFiles?.length || 0) > 0))) {
    result.sourceRevision = (await sourceLifecycleStore(name)).readAuthority().currentRevision
  }
  if (result.ok && result.acceptedSourceMutation && acceptedSourceMutationHandler) {
    await acceptedSourceMutationHandler({
      project: name,
      ...result.acceptedSourceMutation,
      sourceRevision: result.sourceRevision || result.acceptedSourceMutation.sourceRevision,
      sourceDaemonKey: body?.sourceDaemonKey || null,
      requestId: body?.requestId || null,
    })
  }
  emitSourceEditEvent({
    emit: emitGlobalEvent,
    result,
    project: name,
    editedBy: body?.editedBy,
    requestId: body?.requestId || randomUUID(),
  })
  return result
}

export async function processProjectPushSerialized(name, body, transactionTest = {}) {
  if (transactionTest.afterLock) await transactionTest.afterLock()
  let project = await readProject(name)
  if (!project) return { status: 404, ok: false, error: 'Project not found' }

  const { files, deletedFiles, sourceManifest, priorityPages, members, session, sessionAt, editedBy, overleafSync, expectedRevision } = body || {}

  const recoveries = await recoverProjectSourceTransactions(name)
  const unresolved = recoveries.find(item => item.state === 'recovery-required')
  if (unresolved) {
    return { status: 409, ok: false, recoveryRequired: true, recovery: unresolved }
  }
  project = await readProject(name)

  const validation = await validateSourcePushRequest(name, project, { files, deletedFiles, sourceManifest })
  if (!validation.ok) return validation

  const sourceMutation = (files?.length || 0) > 0 || (deletedFiles?.length || 0) > 0
  const lifecycle = await sourceLifecycleStore(name)
  const authorityBefore = lifecycle.readAuthority()
  if (sourceMutation && expectedRevision === undefined) {
    return { status: 428, ok: false, error: 'expectedRevision is required for source mutations', authority: authorityBefore }
  }
  let lifecycleCandidate = null
  if (sourceMutation) {
    const current = authorityBefore.currentRevision ? lifecycle.readRevision(authorityBefore.currentRevision) : null
    const candidate = new Map((current?.files || []).map(file => [file.path, { ...file, encoding: 'base64' }]))
    const inheritedManifest = authorityBefore.state === 'uninitialized'
      ? new Set(await readClientSourceManifest(name))
      : new Set()
    if (authorityBefore.state === 'uninitialized') {
      for (const filePath of normalizeSourceManifest(sourceManifest, sourceManifestContext(project))) {
        if (!inheritedManifest.has(filePath)) continue
        const content = await readSourceFileAsync(name, filePath)
        if (content !== null) candidate.set(filePath, { path: filePath, content: Buffer.from(content).toString('base64'), encoding: 'base64' })
      }
    }
    for (const filePath of deletedFiles || []) candidate.delete(filePath)
    for (const file of files || []) candidate.set(file.path, {
      path: file.path,
      content: file.encoding === 'base64' ? file.content : Buffer.from(String(file.content ?? '')).toString('base64'),
      encoding: 'base64',
    })
    const manifest = normalizeSourceManifest(sourceManifest, sourceManifestContext(project))
    if (candidate.size !== manifest.length || manifest.some(path => !candidate.has(path))) {
      return { status: 409, ok: false, error: authorityBefore.state === 'uninitialized' ? 'Bootstrap requires a complete source snapshot' : 'Proposed snapshot does not match sourceManifest', authority: authorityBefore }
    }
    const observed = inheritedManifest.size > 0
      ? await Promise.all(manifest.map(async path => {
          const serverContent = await readSourceFileAsync(name, path)
          return inheritedManifest.has(path) || serverContent === null
            ? candidate.get(path)
            : { path, content: serverContent }
        }))
      : (await Promise.all(manifest.map(async path => ({ path, content: await readSourceFileAsync(name, path) })))).filter(file => file.content !== null)
    lifecycleCandidate = {
      expectedRevision, sourceManifest: manifest, files: manifest.map(path => candidate.get(path)),
      observedServerFiles: authorityBefore.state === 'uninitialized' && observed.length > 0 ? observed : null,
      observedSourceManifest: observed.map(file => file.path),
    }
  }

  let anyChanged = await sourcePushWouldChange(name, { files, deletedFiles })
  if (members && Array.isArray(members) && project.format === 'book') {
    await updateProject(name, { members })
    return { status: 200, ok: true, members }
  }
  const originalLocalHead = await readOverleafLocalHead(name)
  let transaction
  try {
    transaction = await beginProjectSourceTransaction(name, {
      originalLocalHead,
      failJournalWrite: transactionTest.failAt === 'journal-write',
      durabilityProbe: transactionTest.durabilityProbe,
    })
  } catch (error) {
    return { status: 409, ok: false, error: `Source transaction journal failed: ${error.message}` }
  }
  let preparedOverleaf = null
  const changedPushFiles = []
  let remotePublished = false
  let recoveryJournal = null
  let acceptedSourceMutation = null
  try {
    if (transactionTest.simulateCrashAfterJournal) {
      return { status: 598, ok: false, simulatedCrash: true, recovery: transaction.identity() }
    }
    if (anyChanged && project.overleafRemote && project.autoSync !== false && !overleafSync) {
      preparedOverleaf = await prepareSourcePushToOverleaf(name, { files, deletedFiles, editedBy })
    }
    if (files?.length > 0) {
      for (const [index, file] of files.entries()) {
      const content = file.encoding === 'base64'
        ? Buffer.from(file.content, 'base64')
        : file.content
      const previousContent = await readSourceFileAsync(name, file.path)
      if (await writeSourceFileAsync(name, file.path, content)) {
        changedPushFiles.push({
          path: file.path,
          content,
          regions: changedTextRegions(previousContent, bufferToUtf8(content)),
        })
      }
        if (transactionTest.failAt === `write:${index + 1}`) throw new Error(`Injected failure at write:${index + 1}`)
      }
    }
    if (deletedFiles?.length > 0) {
      for (const [index, filePath] of deletedFiles.entries()) {
        if (!await isClientOwnedSourcePath(name, filePath)) continue
        await deleteSourceFileAsync(name, filePath)
        if (transactionTest.failAt === `delete:${index + 1}`) throw new Error(`Injected failure at delete:${index + 1}`)
      }
    }
    const nextManifest = Array.isArray(sourceManifest)
      ? normalizeSourceManifest(sourceManifest, sourceManifestContext(project))
      : null
    const metadata = {
      ...(session ? { session, sessionAt: sessionAt || Date.now() } : {}),
      ...(editedBy ? { lastEditedBy: editedBy, lastEditedByAt: Date.now() } : {}),
      ...(members && Array.isArray(members) ? { members } : {}),
      ...(preparedOverleaf ? {
        overleafHead: preparedOverleaf.head,
        overleafLastPullAt: Date.now(),
        ...(preparedOverleaf.pushed ? { overleafLastPushAt: Date.now() } : {}),
        overleafSyncStatus: 'ok', overleafSyncError: null, overleafConflictFiles: [],
      } : {}),
    }
    await updateProject(name, metadata)
    if (nextManifest) await updateClientSourceManifest(name, nextManifest)
    if (lifecycleCandidate) {
      const { observedServerFiles, observedSourceManifest, ...candidate } = lifecycleCandidate
      const lifecycleResult = authorityBefore.state === 'uninitialized'
        ? lifecycle.bootstrap({ ...candidate, observedServerFiles, observedSourceManifest })
        : lifecycle.submit(candidate)
      if (!lifecycleResult.ok) {
        const error = new Error(lifecycleResult.status)
        error.lifecycleResult = lifecycleResult
        throw error
      }
      acceptedSourceMutation = {
        previousRevision: authorityBefore.currentRevision || null,
        sourceRevision: lifecycleResult.authority?.currentRevision || null,
        files: changedPushFiles.map(file => ({
          path: file.path,
          content: Buffer.isBuffer(file.content) ? file.content.toString('base64') : Buffer.from(String(file.content ?? '')).toString('base64'),
          encoding: 'base64',
        })),
        deletedFiles: deletedFiles || [],
        sourceManifest: nextManifest || [],
      }
    }
    if (transactionTest.failAt === 'manifest' || transactionTest.failAt === 'clone-restore') {
      throw new Error('Injected failure after manifest persistence')
    }
    if (preparedOverleaf) {
      recoveryJournal = transaction.recordRemotePlan({
        previousRemoteHead: preparedOverleaf.previousRemoteHead,
        proposedRemoteHead: preparedOverleaf.head,
        remoteBranch: preparedOverleaf.remoteBranch,
        originalLocalHead: preparedOverleaf.originalLocalHead,
      })
      await preparedOverleaf.publish()
      remotePublished = preparedOverleaf.pushed
      if (transactionTest.simulateCrashAfterPublish) {
        return { status: 599, ok: false, simulatedCrash: true, recovery: recoveryJournal }
      }
      if (transactionTest.afterRemotePublished) await transactionTest.afterRemotePublished(preparedOverleaf)
      if (transactionTest.failAt === 'after-remote') throw new Error('Injected failure after remote success')
    }
    transaction.commit()
    if (acceptedSourceMutation) {
      try {
        await recordAcceptedSourceTransaction(name, body || {}, acceptedSourceMutation)
      } catch (attributionError) {
        // Source is already committed; attribution is derived and must not roll it back.
        console.error(`[${name}] edit-event attribution record failed: ${attributionError.message}`)
      }
    }
  } catch (e) {
    if (remotePublished) {
      try {
        await preparedOverleaf.restoreRemote()
      } catch (compensationError) {
        const recovery = transaction.abandon()
        console.error(`[${name}] Source transaction requires recovery: ${compensationError.message}`)
        return {
          status: 409, ok: false, recoveryRequired: true,
          error: 'Remote advanced after publish; recovery required',
          recovery: recoveryJournal || recovery,
        }
      }
    }
    const rollbackFailures = []
    if (preparedOverleaf?.restoreLocal) {
      try {
        if (transactionTest.failAt === 'clone-restore') throw new Error('Injected clone restore failure')
        await preparedOverleaf.restoreLocal()
      } catch (restoreError) {
        rollbackFailures.push(`clone restore failed: ${restoreError.message}`)
      }
    }
    try {
      await transaction.rollback()
    } catch (rollbackError) {
      rollbackFailures.push(`local rollback failed: ${rollbackError.message}`)
    }
    console.error(`[${name}] Source transaction failed: ${e.message}`)
    return {
      status: 409, ok: false,
      error: `Source transaction failed: ${e.message}${rollbackFailures.length ? `; ${rollbackFailures.join('; ')}` : ''}`,
      ...(e.lifecycleResult ? { lifecycleStatus: e.lifecycleResult.status, authority: e.lifecycleResult.authority, evidence: e.lifecycleResult.evidence } : {}),
      ...(rollbackFailures.length ? { rollbackFailures } : {}),
    }
  }

  const changedFiles = (files || []).map(f => f.path)
  const changedPartFiles = await refreshMaterializedPartsFromChangedSources(name, project, changedPushFiles)
  const projectPartsChanged = changedPartFiles.length > 0
  // Persisted buildStatus can lag dispatch. The queue is the authority for
  // whether an initial normal build is already queued or running. A `parts`
  // job for this project must not suppress the first page-producing build.
  const decision = shouldBuildOnPush(project, name, {
    changedFiles,
    anyChanged,
    building: isBuildKindPending(name, 'build'),
  })

  if (!decision.build) {
    if (projectPartsChanged) {
      await rebuildProjectPartsView(name, project)
      broadcastProjectPartsChanged(name, changedPartFiles)
      return withAcceptedSourceMutation(withAcceptedChangedFiles({ status: 200, ok: true, filesWritten: files?.length || 0, building: true, partsChanged: true,
        ...(decision.reason === 'already-building' ? { alreadyBuilding: true } : {}),
      }, changedPushFiles), acceptedSourceMutation)
    }
    const filtered = decision.reason === 'outside-tree' || decision.reason === 'relevant-files-parse-failed'
    if (decision.reason === 'relevant-files-parse-failed') {
      console.error(`[${name}] relevant-files.json parse failed`)
    }
    return withAcceptedSourceMutation(withAcceptedChangedFiles({ status: 200, ok: true, filesWritten: files?.length || 0,
      building: decision.reason === 'already-building',
      ...(decision.reason === 'already-building' ? { alreadyBuilding: true } : {}),
      ...(decision.reason === 'unchanged' ? { unchanged: true } : {}),
      ...(filtered ? { filtered: true, reason: decision.reason } : {}),
    }, changedPushFiles), acceptedSourceMutation)
  }

  if (decision.eager) {
    // Non-SVG formats: kick off build async, return immediately.
    dispatchBuild(name).then(async () => {
      if (projectPartsChanged) broadcastProjectPartsChanged(name, changedPartFiles)
      const updated = await readProject(name)
      if (updated?.buildStatus === 'success') {
        emitGlobalEvent('doc-arrived', {
          name, title: updated.title || name,
          format: updated.format, pages: updated.pages || 0,
        })
      }
    }).catch(async e => {
      console.error(`[${project.format}] Build failed for ${name}: ${e.message}`)
      try {
        await updateProject(name, { buildStatus: 'error' })
      } catch (updateError) {
        console.error(`[${project.format}] Failed to record build error for ${name}: ${updateError.message}`)
      }
    })
    return withAcceptedSourceMutation(withAcceptedChangedFiles(
      { status: 200, ok: true, filesWritten: files?.length || 0, building: true },
      changedPushFiles,
    ), acceptedSourceMutation)
  }

  if (projectPartsChanged) {
    await rebuildProjectPartsView(name, project)
    broadcastProjectPartsChanged(name, changedPartFiles)
  }

  // No accepted source change should reach this branch. Every changed format
  // builds eagerly so that the successful build records its Git checkpoint.
  throw new Error(`Build decision for ${name} was neither filtered nor eager`)
}

async function refreshMaterializedPartsFromChangedSources(name, project, changedPushFiles) {
  if (!changedPushFiles.length) return []
  const manifest = await readProjectPartsManifest(name)
  const sourceRoot = getSourceDir(name)
  const changedPartFiles = new Set()

  for (const file of changedPushFiles) {
    const sourcePath = resolve(sourceRoot, file.path)
    const matchingParts = manifest.parts.filter(part => part.metadata?.sourcePath === sourcePath)
    for (const part of matchingParts) {
      const result = await realizeProjectMarkdownArtifact({
        project: name,
        markdown: bufferToUtf8(file.content),
        sourcePath,
        title: part.title,
        provenance: part.metadata?.provenance || {},
      })
      if (result.ready && result.projectPath) changedPartFiles.add(markdownColumnFileForSource(result.projectPath))
    }
  }

  return [...changedPartFiles]
}

async function rebuildProjectPartsView(name, project) {
  if (project?.format === 'markdown') {
    await dispatchBuild(name)
  } else if (!FORMATS_WITH_OWN_PAGE_INFO.has(project?.format)) {
    await dispatchBuild(name, { kind: 'parts' })
  }
}

function bufferToUtf8(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
}

function broadcastProjectPartsChanged(name, files) {
  if (!files.length) return
  broadcastSignal(`doc-${name}`, 'signal:project-parts-changed', { files, timestamp: Date.now() })
}

async function validateSourcePushRequest(name, project, { files, deletedFiles, sourceManifest }) {
  const pushFiles = files || []
  const deletes = deletedFiles || []
  if ((pushFiles.length > 0 || deletes.length > 0) && !Array.isArray(sourceManifest)) {
    return { status: 400, ok: false, error: 'sourceManifest is required for source pushes' }
  }

  const context = sourceManifestContext(project)
  const validateAuthoredPath = (filePath, label) => {
    if (typeof filePath !== 'string' || !filePath) return `${label} must be a non-empty string`
    try {
      validateSourceFilePath(name, filePath)
    } catch (e) {
      return e.message
    }
    const normalized = normalizeSourceManifest([filePath], context)
    if (normalized.length !== 1 || normalized[0] !== filePath || !isSourceFilePath(filePath, context)) {
      return `${label} is not an authored source path: ${filePath}`
    }
    return null
  }

  const validateContainedPath = (filePath, label) => {
    if (typeof filePath !== 'string' || !filePath) return `${label} must be a non-empty string`
    try {
      validateSourceFilePath(name, filePath)
    } catch (e) {
      return e.message
    }
    return null
  }

  for (const file of pushFiles) {
    const error = validateAuthoredPath(file?.path, 'pushed file')
    if (error) return { status: 400, ok: false, error }
  }
  for (const filePath of deletes) {
    const error = validateContainedPath(filePath, 'deleted file')
    if (error) return { status: 400, ok: false, error }
  }

  if (!Array.isArray(sourceManifest)) return { status: 200, ok: true }

  const declared = new Set()
  for (const filePath of sourceManifest) {
    const error = validateAuthoredPath(filePath, 'sourceManifest entry')
    if (error) return { status: 400, ok: false, error }
    declared.add(filePath)
  }

  for (const file of pushFiles) {
    if (!declared.has(file.path)) {
      return { status: 400, ok: false, error: `sourceManifest missing pushed file: ${file.path}` }
    }
  }
  for (const filePath of deletes) {
    if (declared.has(filePath)) {
      return { status: 400, ok: false, error: `sourceManifest still contains deleted file: ${filePath}` }
    }
  }

  const sourceRoot = getSourceDir(name)
  const proposed = new Set()
  for (const filePath of await readClientSourceManifest(name)) {
    const error = validateAuthoredPath(filePath, 'stored sourceManifest entry')
    if (error) return { status: 400, ok: false, error }
    if (await pathExists(join(sourceRoot, filePath))) proposed.add(filePath)
  }
  for (const filePath of deletes) proposed.delete(filePath)
  for (const file of pushFiles) proposed.add(file.path)

  const missing = [...proposed].filter(filePath => !declared.has(filePath)).sort()
  if (missing.length > 0) {
    return { status: 400, ok: false, error: `sourceManifest missing surviving authored file: ${missing[0]}` }
  }
  const extra = [...declared].filter(filePath => !proposed.has(filePath)).sort()
  if (extra.length > 0) {
    return { status: 400, ok: false, error: `sourceManifest contains nonexistent authored file: ${extra[0]}` }
  }
  return { status: 200, ok: true }
}

// Exported for the dormant lifecycle contract tests. This does not change any
// route or caller behavior before the Phase B ingress cutover.
export async function validateSourceLifecycleCandidate(name, project, candidate) {
  return validateSourcePushRequest(name, project, candidate)
}

async function sourcePushWouldChange(name, { files, deletedFiles }) {
  for (const file of files || []) {
    const next = file.encoding === 'base64'
      ? Buffer.from(file.content, 'base64')
      : Buffer.from(String(file.content ?? ''))
    const full = join(getSourceDir(name), file.path)
    if (!await pathExists(full)) return true
    if (!(await readFile(full)).equals(next)) return true
  }
  for (const filePath of deletedFiles || []) {
    if (await isClientOwnedSourcePath(name, filePath) && await pathExists(join(getSourceDir(name), filePath))) return true
  }
  return false
}

// Push files + trigger build
router.post('/:name/push', requireRw, async (req, res) => {
  const result = await processProjectPush(req.params.name, req.body)
  const { status, lifecycleStatus, ...payload } = result
  res.status(status).json({ ...payload, ...(lifecycleStatus ? { status: lifecycleStatus } : {}) })
})

// Trigger rebuild (no file changes)
router.post('/:name/build', requireRw, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const { priorityPages } = req.body || {}
  const clean = req.query.clean === '1'

  // Clean build: delete aux/biber cache files before rebuilding
  if (clean) {
    const projDir = getProjectDir(req.params.name)
    const mainFile = project.mainFile || 'main.tex'
    const texBase = mainFile.split('/').pop().replace(/\.tex$/i, '')
    try {
      await rm(join(projDir, '.biber-par-cache'), { recursive: true, force: true })
      for (const ext of ['.bbl', '.blg', '.run.xml']) {
        await rm(join(projDir, 'build-cache', `${texBase}${ext}`), { force: true })
      }
      console.log(`[api] Clean build: cleared biber cache for ${req.params.name}`)
    } catch (e) {
      console.error(`[api] Clean build: failed to clear biber cache for ${req.params.name}: ${e.message}`)
      return res.status(500).json({ error: 'Clean build failed to clear biber cache', detail: e.message })
    }
    const srcDir = getSourceDir(req.params.name)
    if (await pathExists(srcDir)) {
      const cleanExts = ['.aux', '.bbl', '.bcf', '.blg', '.run.xml', '.fls', '.fdb_latexmk', '.synctex.gz', '.log', '.out', '.toc', '.lof', '.lot']
      for (const file of await readdir(srcDir)) {
        if (cleanExts.some(ext => file.endsWith(ext))) {
          try {
            await unlink(join(srcDir, file))
          } catch (e) {
            console.error(`[api] Clean build: failed to delete aux file ${file} for ${req.params.name}: ${e.message}`)
            return res.status(500).json({ error: 'Clean build failed to delete aux file', file, detail: e.message })
          }
        }
      }
      console.log(`[api] Clean build: deleted aux files for ${req.params.name}`)
    }
  }

  res.json({ ok: true, building: true, clean })

  try {
    await dispatchBuild(req.params.name, { priorityPages })
  } catch (e) {
    console.error(`[api] Build failed for ${req.params.name}: ${e.message}`)
  }
})

// Build status + log
router.get('/:name/build/status', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const activeBuild = getBuildStatus(req.params.name)
  const buildLog = await readBuildLogAsync(req.params.name)
  const { errors, warnings } = await extractBuildErrors(req.params.name)
  const pipelineWarnings = await extractPipelineWarningsAsync(req.params.name)

  res.json({
    status: activeBuild?.building ? 'building' : project.buildStatus,
    phase: activeBuild?.phase || null,
    lastBuild: project.lastBuild,
    log: buildLog,
    errors,
    warnings,
    pipelineWarnings,
  })
})

// LaTeX errors from the build log
router.get('/:name/build/errors', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const activeBuild = getBuildStatus(req.params.name)
  const building = activeBuild?.building || false

  const { errors, warnings } = await extractBuildErrors(req.params.name)
  const pipelineWarnings = await extractPipelineWarningsAsync(req.params.name)

  res.json({
    building,
    phase: activeBuild?.phase || null,
    status: project.buildStatus,
    lastBuild: project.lastBuild,
    errors: errors.map(e => e.message), // API returns flat strings for CLI compat
    warnings,
    pipelineWarnings,
  })
})

// ---------- Shape CRUD (backed by @tldraw/sync TLSocketRoom) ----------

// Map project name → sync room name (viewer connects as "doc-{name}")
function syncRoomName(projectName) {
  return `doc-${projectName}`
}

// GET /:name/shapes — list shapes, optionally filter by type
router.get('/:name/shapes', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })
  const records = await getRoomRecords(syncRoomName(req.params.name), req.query.type || null)
  res.json(records)
})

// GET /:name/shapes/at/:timestamp — reconstruct shapes at a point in time
router.get('/:name/shapes/at/:timestamp', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })
  const ts = parseInt(req.params.timestamp, 10)
  if (isNaN(ts) || ts <= 0) return res.status(400).json({ error: 'Invalid timestamp (unix ms)' })
  const result = await getShapesAt(req.params.name, ts)
  res.json(result)
})

// POST /:name/shapes — create a shape
router.post('/:name/shapes', requireRw, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })
  const shape = req.body
  if (!shape?.id || !shape?.type) return res.status(400).json({ error: 'Shape must have id and type' })
  // Stamp creation time for temporal clustering
  if (!shape.meta) shape.meta = {}
  if (!shape.meta.createdAt) shape.meta.createdAt = Date.now()
  // Default required TLDraw fields if not provided
  if (!shape.parentId) shape.parentId = 'page:page'
  if (!shape.index) shape.index = 'a1'
  try {
    await putShape(syncRoomName(req.params.name), shape)
    res.json({ ok: true, id: shape.id })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PUT /:name/shapes/:id — atomic update (send partial props to merge)
router.put('/:name/shapes/:id', requireRw, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })
  const shapeId = req.params.id.startsWith('shape:') ? req.params.id : `shape:${req.params.id}`
  const updates = req.body
  try {
    await updateShape(syncRoomName(req.params.name), shapeId, (current) => {
      // Deep merge props
      const merged = { ...current, ...updates }
      if (updates.props) {
        merged.props = { ...current.props, ...updates.props }
      }
      if (updates.meta) {
        merged.meta = { ...current.meta, ...updates.meta }
      }
      // Preserve identity fields
      merged.id = current.id
      merged.type = current.type
      merged.typeName = current.typeName
      return merged
    })
    res.json({ ok: true, id: shapeId })
  } catch (e) {
    if (e.message.includes('not found')) return res.status(404).json({ error: e.message })
    res.status(500).json({ error: e.message })
  }
})

// DELETE /:name/shapes/:id — delete a shape
router.delete('/:name/shapes/:id', requireRw, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })
  const shapeId = req.params.id.startsWith('shape:') ? req.params.id : `shape:${req.params.id}`
  try {
    await deleteShape(syncRoomName(req.params.name), shapeId)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /:name/snapshot — replace the sync room's snapshot (for publish/deploy)
router.post('/:name/snapshot', requireRw, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })
  const snapshot = req.body
  if (!snapshot?.documents) return res.status(400).json({ error: 'Invalid snapshot (missing documents)' })
  try {
    replaceRoomSnapshot(syncRoomName(req.params.name), snapshot)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /:name/sync/clear — delete the sync snapshot so the room resets on next connect
router.post('/:name/sync/clear', requireRw, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })
  try {
    // Replace with an empty snapshot (no shapes)
    const emptySnapshot = { documents: [], schema: undefined }
    replaceRoomSnapshot(syncRoomName(req.params.name), emptySnapshot)
    res.json({ ok: true, message: `Sync data cleared for ${req.params.name}` })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /:name/sync/health — check if a doc's sync room can load without errors
router.get('/:name/sync/health', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })
  try {
    const room = await getOrCreateRoom(syncRoomName(req.params.name))
    const snapshot = room.getCurrentSnapshot()
    const shapeCount = snapshot.documents?.filter(d => d.state?.typeName === 'shape').length || 0
    res.json({ ok: true, shapes: shapeCount })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

// POST /:name/signal — broadcast a signal to all connected viewers
router.post('/:name/signal', requireRw, async (req, res) => {
  const { key, ...data } = req.body
  if (!key) return res.status(400).json({ error: 'key is required' })
  broadcastSignal(syncRoomName(req.params.name), key, data)
  // When a compare signal arrives, protect that hash from pruning
  if (key === 'signal:compare') {
    const { setCompareRef } = await import('../lib/shadow-repo.mjs')
    const ref = data?.data?.ref
    setCompareRef(req.params.name, ref ? ref.slice(0, 7) : null)
  }
  res.json({ ok: true })
})

// GET /:name/signal/stream — SSE stream of signal broadcasts (must be before :key route)
router.get('/:name/signal/stream', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })
  res.write('data: {"type":"connected"}\n\n')

  // SSE keepalive to prevent proxy (Fly) from killing idle connections
  const keepalive = setInterval(() => res.write(':\n\n'), 15000)

  const unsub = onSignal(syncRoomName(req.params.name), (signal) => {
    res.write(`data: ${JSON.stringify(signal)}\n\n`)
  })

  req.on('close', () => { clearInterval(keepalive); unsub() })
})

// GET /:name/signal/:key — read last cached value of a signal
router.get('/:name/signal/:key', requireRead, async (req, res) => {
  const signal = getLastSignal(syncRoomName(req.params.name), req.params.key)
  if (!signal) return res.status(404).json({ error: 'No cached signal' })
  res.json(signal)
})

// GET /:name/highlight-feedback — structured feedback from highlight shapes
router.get('/:name/highlight-feedback', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })

  const records = await getRoomRecords(syncRoomName(req.params.name), 'highlight')
  const feedback = records
    .map(highlightFeedbackFromShape)
    .filter(Boolean)
    .sort(compareHighlightFeedbackBySource)

  res.json({ doc: req.params.name, feedback })
})

// POST /:name/extract — extract source lines to a markdown scratch note
router.post('/:name/extract', requireRw, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })

  const { startLine, endLine, file, x, y } = req.body
  if (!startLine || !endLine) return res.status(400).json({ error: 'startLine and endLine required' })

  const texFile = file || project.mainFile || 'main.tex'
  const content = await readSourceFileAsync(req.params.name, texFile)
  if (content === null) return res.status(404).json({ error: `Source file "${texFile}" not found` })

  const lines = content.split('\n')
  const extracted = lines.slice(startLine - 1, endLine).join('\n')

  let mdContent
  try {
    ;({ stdout: mdContent } = await execFileWithInput(
      'pandoc',
      ['-f', 'latex', '-t', 'markdown', '--wrap=none'],
      extracted,
      { encoding: 'utf8', timeout: 10000 },
    ))
  } catch (e) {
    return res.status(500).json({ error: `pandoc conversion failed: ${e.message}` })
  }
  mdContent = mdContent.replace(/\\ref\{([\w:.-]+)\}/g, '@$1')

  const slug = `extract-L${startLine}-${endLine}`
  const srcDir = getSourceDir(req.params.name)
  const scratchDir = join(srcDir, 'scratch')
  await mkdir(scratchDir, { recursive: true })
  const mdPath = join(scratchDir, `${slug}.md`)
  await writeFile(mdPath, mdContent, 'utf8')

  const noteX = (x ?? 690) + 20
  const noteY = y ?? 0
  const shapeId = `shape:extract-${Date.now()}`

  const allShapes = await getRoomRecords(syncRoomName(req.params.name))
  let maxIndex = 'a1'
  for (const s of allShapes) {
    if (s.typeName === 'shape' && s.index && s.index > maxIndex) maxIndex = s.index
  }
  const { getIndexAbove } = await import('tldraw')
  const noteIndex = getIndexAbove(maxIndex)

  const shape = {
    id: shapeId,
    type: 'math-note',
    typeName: 'shape',
    x: noteX, y: noteY,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    props: { w: 350, h: 200, text: mdContent, color: 'violet', autoSize: true },
    meta: {
      sourceAnchor: { file: `./${texFile}`, line: startLine, column: -1, content: lines[startLine - 1] || '' },
      extractedFrom: { startLine, endLine, file: texFile },
      createdAt: Date.now(),
    },
    parentId: 'page:page',
    index: noteIndex,
  }

  try {
    await putShape(syncRoomName(req.params.name), shape)
    res.json({ ok: true, shapeId, scratchFile: mdPath, lines: `${startLine}–${endLine}` })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /:name/inject — convert markdown note content to LaTeX and inject as scratch section
router.post('/:name/inject', requireRw, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })

  const { markdown, anchorLine, anchorFile } = req.body
  if (!markdown) return res.status(400).json({ error: 'markdown content required' })

  let texContent = markdown.replace(/(?<![\\@\w])@([\w:.-]+)/g, '\\ref{$1}')
  try {
    ;({ stdout: texContent } = await execFileWithInput(
      'pandoc',
      ['-f', 'markdown', '-t', 'latex', '--wrap=none'],
      texContent,
      { encoding: 'utf8', timeout: 10000 },
    ))
  } catch (e) {
    return res.status(500).json({ error: `pandoc conversion failed: ${e.message}` })
  }

  const label = `inject-L${anchorLine || 0}-${Date.now()}`
  const filename = label.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.tex'
  const scratchPath = `.tlda/scratch/${filename}`
  const rawContent = texContent.endsWith('\n') ? texContent : texContent + '\n'

  const sourceDir = project.sourceDir
  if (!sourceDir) return res.status(400).json({ error: 'No sourceDir for this project' })

  const scratchDir = join(sourceDir, '.tlda', 'scratch')
  await mkdir(scratchDir, { recursive: true })
  await writeFile(join(sourceDir, scratchPath), rawContent, 'utf8')

  res.json({ ok: true, scratchPath, label, texContent })
})

// GET /:name/shapes/stream — SSE stream of shape changes (must be before :id route)
router.get('/:name/shapes/stream', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })
  res.write('data: {"type":"connected"}\n\n')

  // SSE keepalive to prevent proxy (Fly) from killing idle connections
  const keepalive = setInterval(() => res.write(':\n\n'), 15000)

  // Ensure room exists so we get change notifications (fire-and-forget — SSE doesn't wait)
  getOrCreateRoom(syncRoomName(req.params.name)).catch(e => console.warn(`[projects] room creation failed for ${req.params.name}: ${e.message}`))

  const unsub = onShapeChange(syncRoomName(req.params.name), (event) => {
    // Slim down changes for SSE — send action, id, shapeType, meta but not full state/diff
    const slim = { ...event }
    if (slim.changes) {
      slim.changes = slim.changes.map(c => {
        const entry = { action: c.action, id: c.id, shapeType: c.shapeType }
        if (c.state?.meta) entry.meta = c.state.meta
        return entry
      })
    }
    res.write(`data: ${JSON.stringify(slim)}\n\n`)
  })

  req.on('close', () => { clearInterval(keepalive); unsub() })
})

// GET /:name/shapes/:id — get a single shape
router.get('/:name/shapes/:id', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })
  const shapeId = req.params.id.startsWith('shape:') ? req.params.id : `shape:${req.params.id}`
  const record = await getRecord(syncRoomName(req.params.name), shapeId)
  if (!record) return res.status(404).json({ error: 'Shape not found' })
  res.json(record)
})

// --- Coordinate constants (shared/layout-constants.json) ---
const _lc = JSON.parse(await readFile(join(import.meta.dirname, '..', '..', 'shared', 'layout-constants.json'), 'utf8'))
const PDF_WIDTH = _lc.PDF_WIDTH        // 612
const PDF_HEIGHT = _lc.PDF_HEIGHT      // 792
const TARGET_WIDTH = _lc.TARGET_WIDTH  // 800
const PAGE_GAP = _lc.PAGE_GAP          // 32
const PAGE_HEIGHT = PDF_HEIGHT * (TARGET_WIDTH / PDF_WIDTH)
const VIEWBOX_OFFSET = 72

function pdfToCanvasLocal(page, pdfX, pdfY) {
  const pageY = (page - 1) * (PAGE_HEIGHT + PAGE_GAP)
  const scaleX = TARGET_WIDTH / PDF_WIDTH
  const scaleY = PAGE_HEIGHT / PDF_HEIGHT
  return {
    x: (pdfX + VIEWBOX_OFFSET) * scaleX,
    y: pageY + (pdfY + VIEWBOX_OFFSET) * scaleY,
  }
}

// --- Float16 encode/decode for TLDraw base64 path segments ---
function toFloat16(value) {
  if (value === 0) return 0
  if (!isFinite(value)) return value > 0 ? 0x7c00 : 0xfc00
  const sign = value < 0 ? 1 : 0
  value = Math.abs(value)
  if (value > 65504) return sign ? 0xfc00 : 0x7c00
  if (value < 5.96e-8) return sign << 15
  const log2 = Math.log2(value)
  let exp = Math.floor(log2)
  let frac = value / Math.pow(2, exp) - 1
  if (exp < -14) {
    frac = value / Math.pow(2, -14)
    return (sign << 15) | Math.round(frac * 1024)
  }
  exp += 15
  if (exp >= 31) return sign ? 0xfc00 : 0x7c00
  return (sign << 15) | (exp << 10) | Math.round(frac * 1024)
}
function float16(bits) {
  const sign = bits >> 15
  const exp = (bits >> 10) & 0x1f
  const frac = bits & 0x3ff
  if (exp === 0) { const val = frac * (Math.pow(2, -14) / 1024); return sign ? -val : val }
  if (exp === 31) return frac ? NaN : (sign ? -Infinity : Infinity)
  const val = Math.pow(2, exp - 15) * (1 + frac / 1024)
  return sign ? -val : val
}

function encodeB64Path(points) {
  if (points.length === 0) return ''
  const firstBytes = 12
  const deltaBytes = (points.length - 1) * 6
  const buf = Buffer.alloc(firstBytes + deltaBytes)
  buf.writeFloatLE(points[0].x, 0)
  buf.writeFloatLE(points[0].y, 4)
  buf.writeFloatLE(points[0].z ?? 0.5, 8)
  let prevX = points[0].x, prevY = points[0].y, prevZ = points[0].z ?? 0.5
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - prevX
    const dy = points[i].y - prevY
    const dz = (points[i].z ?? 0.5) - prevZ
    const off = 12 + (i - 1) * 6
    buf.writeUInt16LE(toFloat16(dx), off)
    buf.writeUInt16LE(toFloat16(dy), off + 2)
    buf.writeUInt16LE(toFloat16(dz), off + 4)
    prevX += float16(toFloat16(dx))
    prevY += float16(toFloat16(dy))
    prevZ += float16(toFloat16(dz))
  }
  return buf.toString('base64')
}

function wordSpanAtColumn(lineText, column) {
  if (!lineText) return null
  const len = lineText.length
  let pos = Math.max(0, Math.min(Math.floor(Number(column) || 0), len - 1))
  if (/\s/.test(lineText[pos]) && pos > 0 && !/\s/.test(lineText[pos - 1])) pos -= 1
  while (pos < len && /\s/.test(lineText[pos])) pos += 1
  if (pos >= len) {
    pos = len - 1
    while (pos >= 0 && /\s/.test(lineText[pos])) pos -= 1
  }
  if (pos < 0) return null

  let start = pos
  let end = pos + 1
  const isWord = (ch) => /[A-Za-z0-9_:\\.-]/.test(ch)
  const isCommand = lineText[start] === '\\' || (start > 0 && lineText[start - 1] === '\\')
  if (isCommand) {
    if (lineText[start] !== '\\') start -= 1
    end = start + 1
    while (end < len && /[A-Za-z@]+/.test(lineText[end])) end += 1
    return end > start + 1 ? { start, end } : null
  }
  if (isWord(lineText[pos])) {
    while (start > 0 && isWord(lineText[start - 1])) start -= 1
    while (end < len && isWord(lineText[end])) end += 1
    return { start, end }
  }
  return { start: pos, end: Math.min(len, pos + 1) }
}

// POST /:name/source-cursor — word-level source cursor location using highlight span resolver
router.post('/:name/source-cursor', requireRead, async (req, res) => {
  const name = req.params.name
  const project = await readProject(name)
  if (!project) return res.status(404).json({ error: 'Not found' })

  const file = req.body.file || project.mainFile || project.main
  const line = Math.max(1, Math.floor(Number(req.body.line || 1)))
  const column = Math.max(0, Math.floor(Number(req.body.column || 0)))
  if (!file) return res.status(400).json({ error: 'No source file configured' })

  try {
    const sourceContent = await readSourceFileAsync(name, file)
    if (!sourceContent) return res.status(404).json({ error: `Source file not found: ${file}` })
    const sourceLines = sourceContent.split('\n')
    const lineText = sourceLines[line - 1] || ''
    const wordSpan = wordSpanAtColumn(lineText, column)
    if (!wordSpan) return res.status(404).json({ error: `No word near ${file}:${line}:${column}` })

    const geometry = await sourceTextSpanToPdfSpans(name, file, sourceLines, {
      startLine: line,
      startCol: wordSpan.start,
      endLine: line,
      endCol: wordSpan.end,
    })
    if (!geometry) return res.status(404).json({ error: `Could not compute cursor position for ${file}:${line}` })

    res.json({
      ok: true,
      file,
      line,
      column,
      text: lineText.slice(wordSpan.start, wordSpan.end),
      startCol: wordSpan.start,
      endCol: wordSpan.end,
      page: geometry.page,
      pdfSpans: geometry.pdfSpans,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /:name/highlight — text-based highlight using synctex data
router.post('/:name/highlight', requireRead, async (req, res) => {
  const name = req.params.name
  const project = await readProject(name)
  if (!project) return res.status(404).json({ error: 'Not found' })

  const { text, startLine, color = 'orange', file } = req.body
  if (!text || startLine == null) {
    return res.status(400).json({ error: 'Missing required parameters: text, startLine' })
  }

  try {
    // 1. Read the source file
    const mainFile = file || project.mainFile || project.main
    if (!mainFile) return res.status(400).json({ error: 'No main file configured for project' })
    if (!await readSourceFileAsync(name, mainFile)) return res.status(404).json({ error: `Source file not found: ${mainFile}` })

    const match = await findTextNearSourceLine(name, mainFile, startLine, text)
    if (!match) {
      return res.status(404).json({ error: `Text "${text.slice(0, 50)}..." not found near line ${startLine}` })
    }
    const {
      sourceLines,
      startLine: matchStartLine,
      startCol: matchStartCol,
      endLine: matchEndLine,
      endCol: matchEndCol,
    } = match
    const geometry = await sourceTextSpanToPdfSpans(name, mainFile, sourceLines, {
      startLine: matchStartLine,
      startCol: matchStartCol,
      endLine: matchEndLine,
      endCol: matchEndCol,
    })
    if (!geometry) {
      return res.status(404).json({ error: `Could not compute highlight position for lines ${matchStartLine}–${matchEndLine}` })
    }

    const page = geometry.page
    const segments = []
    let hlLeft = Infinity, hlRight = -Infinity
    let hlTop = Infinity, hlBottom = -Infinity

    for (const pdfSpan of geometry.pdfSpans) {
      const canvasStart = pdfToCanvasLocal(page, pdfSpan.xStart, pdfSpan.y)
      const canvasEnd = pdfToCanvasLocal(page, pdfSpan.xEnd, pdfSpan.y)
      hlLeft = Math.min(hlLeft, canvasStart.x)
      hlRight = Math.max(hlRight, canvasEnd.x)
      hlTop = Math.min(hlTop, canvasStart.y - 3)
      hlBottom = Math.max(hlBottom, canvasStart.y + 3)
    }

    if (hlLeft === Infinity) {
      return res.status(404).json({ error: `Could not compute highlight position for lines ${matchStartLine}–${matchEndLine}` })
    }

    for (const pdfSpan of geometry.pdfSpans) {
      const canvasStart = pdfToCanvasLocal(page, pdfSpan.xStart, pdfSpan.y)
      const canvasEnd = pdfToCanvasLocal(page, pdfSpan.xEnd, pdfSpan.y)
      const segLeft = canvasStart.x - hlLeft
      const segRight = canvasEnd.x - hlLeft
      const segY = canvasStart.y - 3 - hlTop

      segments.push({ type: 'free', path: encodeB64Path([
        { x: segLeft, y: segY, z: 0.5 },
        { x: segRight, y: segY, z: 0.5 },
      ])})
    }

    // 5. Create highlight shape via putShape (on top of all existing shapes)
    const shapeId = `shape:hl-${Date.now().toString(36)}`
    const allRecords = await getRoomRecords(syncRoomName(req.params.name), null)
    const maxIndex = allRecords
      .map(r => r.index || 'a0')
      .sort()
      .pop() || 'a0'
    // Append 'V' to put it after the highest existing index
    const topIndex = maxIndex + 'V'
    const shape = {
      id: shapeId,
      type: 'highlight',
      x: hlLeft,
      y: hlTop,
      index: topIndex,
      rotation: 0,
      isLocked: false,
      opacity: 0.7,
      props: {
        segments,
        color,
        size: 's',
        isComplete: true,
        isPen: false,
        scale: 1,
        scaleX: 1,
        scaleY: 1,
      },
      meta: {
        createdAt: Date.now(),
        highlightedText: text,
        highlightText: (() => {
          // Build context + ⟦highlight⟧ markers from the matched source
          const ctxStart = Math.max(0, matchStartLine - 2)
          const ctxEnd = Math.min(sourceLines.length, matchEndLine + 1)
          const passage = sourceLines.slice(ctxStart, ctxEnd).join(' ')
          const matchInPassage = passage.indexOf(text)
          if (matchInPassage >= 0) {
            const before = passage.slice(Math.max(0, matchInPassage - 40), matchInPassage)
            const after = passage.slice(matchInPassage + text.length, matchInPassage + text.length + 40)
            return (matchInPassage > 40 ? '...' : '') + before + '⟦' + text + '⟧' + after + (matchInPassage + text.length + 40 < passage.length ? '...' : '')
          }
          return '⟦' + text + '⟧'
        })(),
        sourceLines: sourceLines.slice(Math.max(0, matchStartLine - 2), matchEndLine + 1).map((content, i) => {
          const line = matchStartLine - 1 + i
          const isMatch = line >= matchStartLine && line <= matchEndLine
          return { line, content, highlighted: isMatch }
        }),
        sourceAnchor: { file: file || mainFile, line: matchStartLine },
      },
      parentId: 'page:page',
      typeName: 'shape',
    }

    await putShape(syncRoomName(name), shape)
    res.json({ ok: true, shapeId, page, startLine: matchStartLine, endLine: matchEndLine })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /:name/input-scratch — inject a scratch .tex file into the document
router.post('/:name/input-scratch', requireRw, async (req, res) => {
  const { content, label, after, before, replace, agentId, agentName, format, contentPath } = req.body
  if (!content) return res.status(400).json({ error: 'content is required' })
  if (!label) return res.status(400).json({ error: 'label is required' })
  if (!after && !before && !replace) return res.status(400).json({ error: 'one of after, before, or replace is required' })

  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  if (!project.mainFile) return res.status(400).json({ error: 'Project has no mainFile (book format not supported)' })

  const mainContent = await readSourceFileAsync(req.params.name, project.mainFile)
  if (!mainContent) return res.status(400).json({ error: `Main file not found: ${project.mainFile}` })
  const projectSourceFiles = await listSourceFiles(req.params.name)

  const isMd = format === 'md'
  const baseFilename = label.replace(/[^a-z0-9]/gi, '-').toLowerCase()
  const filename = baseFilename + '.tex'
  const mainDir = dirname(project.mainFile)
  const scratchRel = `.tlda/scratch/${filename}`
  const scratchPath = mainDir !== '.' ? join(mainDir, scratchRel) : scratchRel
  const sourceRel = isMd ? `.tlda/scratch/${baseFilename}.md` : null
  const sourcePath = (isMd && mainDir !== '.') ? join(mainDir, sourceRel) : sourceRel
  // Display path for \inputscratch — agent's file path relative to sourceDir
  const displayPath = contentPath || scratchRel

  // Wrap content in scratch environment, signed with agent + timestamp
  const tz = project.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
  const timestamp = new Date().toLocaleString('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).slice(0, 16)
  const signer = agentName || 'agent'
  const displayHeader = `${label} — ${signer} — ${timestamp}`
  const rawContent = content.endsWith('\n') ? content : content + '\n'
  const wrappedContent = isMd ? `% Generated from ${baseFilename}.md — do not edit; build runner overwrites this.\n` : rawContent

  // Canonical scratch template — defines \inputscratch as a marker.
  //
  // The local definition is a pure marker: no file lookup, no \input. A user
  // who builds main.tex locally with vanilla latex sees a visible framebox
  // per scratch section. The tlda build runner ships its OWN scratch-template
  // (with the real-include version of \inputscratch) into buildDir/.tlda/scratch/
  // before pdflatex runs; TEXINPUTS puts buildDir first so the override wins
  // and the server build sees the actual content.
  //
  // The .tlda/scratch/ directory is fully tlda-managed: agents never edit it
  // directly, and the MCP rewrites the template unconditionally on every
  // input_scratch call. No version tags, no user-customized variants.
  const scratchTemplateRel = '.tlda/scratch/scratch-template.tex'
  const scratchTemplatePath = mainDir !== '.' ? join(mainDir, scratchTemplateRel) : scratchTemplateRel
  const scratchTemplateContent = [
    '% tlda scratch-template — regenerated by input_scratch; do not edit.',
    '% Marker version — used for local builds. The tlda build runner swaps in',
    '% a version that actually \\input{}s the scratch content.',
    '\\usepackage{xcolor}',
    '\\newcommand{\\inputscratch}[3]{%',
    '  \\begingroup',
    '  \\par\\noindent',
    '  \\framebox[\\linewidth]{\\parbox{\\dimexpr\\linewidth-2em}{%',
    '    \\footnotesize\\ttfamily',
    '    [tlda scratch placeholder: \\detokenize{#2}]\\par',
    '    Header: #3\\par',
    '    Source: \\detokenize{#1}\\par',
    '    Built by tlda; local builds show this marker only.%',
    '  }}%',
    '  \\label{#2}%',
    '  \\endgroup\\par',
    '}',
    '',
  ].join('\n')

  if (replace) {
    const mainLines = mainContent.split('\n')
    const scratchLineIdx = mainLines.findIndex(l => l.includes(`\\inputscratch`) && l.includes(`{${label}}`))
    let mainContentUpdated = null
    if (scratchLineIdx >= 0) {
      mainLines[scratchLineIdx] = `\\inputscratch{${displayPath}}{${label}}{${displayHeader}}`
      mainContentUpdated = mainLines.join('\n')
    }
    return res.json({ ok: true, scratchPath, sourcePath, wrappedContent, scratchTemplatePath, scratchTemplateContent, mainFile: project.mainFile, mainContent: mainContentUpdated, action: 'replaced' })
  }

  // Check if this scratch label already exists — agents should edit in place, not create new files
  const allSourceFiles = [mainContent]
  for (const f of projectSourceFiles) {
    if (f !== project.mainFile) {
      const fc = await readSourceFileAsync(req.params.name, f)
      if (fc) allSourceFiles.push(fc)
    }
  }
  for (const fc of allSourceFiles) {
    const existingScratchLine = fc.split('\n').find(l => l.includes('\\inputscratch') && l.includes(`{${label}}`))
    if (existingScratchLine) {
      const existingFileMatch = existingScratchLine.match(/\\inputscratch\{([^}]+)\}/)
      const existingFile = existingFileMatch ? existingFileMatch[1] : scratchRel
      return res.status(400).json({
        error: `Scratch section "${label}" already exists in the document (${existingFile}). Edit the scratch file directly instead of creating a new one — the watcher will detect changes and rebuild. Use replace: "${label}" if you need to update the \\inputscratch line itself.`
      })
    }
  }

  // Resolve location label to a line number in main.tex
  const locationLabel = after || before
  const mainLines = mainContent.split('\n')

  // Environments treated as document-level containers — don't climb out of these
  const TRANSPARENT_ENVS = new Set(['document', 'appendix'])

  // Given a 0-indexed label line, scan backward to find an enclosing \begin{ENV},
  // then forward to the matching \end{ENV}, and return the 1-indexed line after it.
  // Falls back to labelLineIdx+1 (after label line) if no enclosing env is found.
  function climbToEnvEnd(labelLineIdx) {
    const openCounts = {}
    for (let j = labelLineIdx; j >= 0; j--) {
      // Check for \end{ENV} first (going backward, ends precede their begins)
      const endM = mainLines[j].match(/\\end\{([^}]+)\}/)
      if (endM) {
        const env = endM[1]
        openCounts[env] = (openCounts[env] || 0) + 1
        continue
      }
      const beginM = mainLines[j].match(/\\begin\{([^}]+)\}/)
      if (beginM) {
        const env = beginM[1]
        if (TRANSPARENT_ENVS.has(env)) continue
        if ((openCounts[env] || 0) > 0) {
          openCounts[env]--  // this begin matches an end we already passed
        } else {
          // Unclosed \begin{env} at line j — the label is inside it; find the matching \end
          let depth = 0
          for (let k = j; k < mainLines.length; k++) {
            if (mainLines[k].includes(`\\begin{${env}}`)) depth++
            if (mainLines[k].includes(`\\end{${env}}`)) {
              depth--
              if (depth === 0) return k + 1  // 1-indexed: after \end{env}
            }
          }
          break  // couldn't find matching \end — fall back
        }
      }
    }
    return labelLineIdx + 1  // no enclosing env, or couldn't close it — after label line
  }

  async function resolveLocation(locLabel) {
    // 1. Search main file for \label{X}
    for (let i = 0; i < mainLines.length; i++) {
      if (mainLines[i].includes(`\\label{${locLabel}}`)) return { file: project.mainFile, line: climbToEnvEnd(i), labelLine: i + 1 }
    }

    // 2. Search included files; resolve within that file (not the main file's \input line)
    // Prefer files in the same directory tree as mainFile
    const allFiles = projectSourceFiles.filter(f => f !== project.mainFile)
    allFiles.sort((a, b) => {
      const aInMain = (mainDir === '.' || a.startsWith(mainDir + '/')) ? 0 : 1
      const bInMain = (mainDir === '.' || b.startsWith(mainDir + '/')) ? 0 : 1
      return aInMain - bInMain
    })
    for (const file of allFiles) {
      const fc = await readSourceFileAsync(req.params.name, file)
      if (!fc || !fc.includes(`\\label{${locLabel}}`)) continue
      const incLines = fc.split('\n')
      for (let i = 0; i < incLines.length; i++) {
        if (incLines[i].includes(`\\label{${locLabel}}`)) {
          const envEnd = (() => {
            const openCounts = {}
            for (let j = i; j >= 0; j--) {
              const endM = incLines[j].match(/\\end\{([^}]+)\}/)
              if (endM) { openCounts[endM[1]] = (openCounts[endM[1]] || 0) + 1; continue }
              const beginM = incLines[j].match(/\\begin\{([^}]+)\}/)
              if (beginM) {
                const env = beginM[1]
                if (TRANSPARENT_ENVS.has(env)) continue
                if ((openCounts[env] || 0) > 0) { openCounts[env]--; continue }
                let depth = 0
                for (let k = j; k < incLines.length; k++) {
                  if (incLines[k].includes(`\\begin{${env}}`)) depth++
                  if (incLines[k].includes(`\\end{${env}}`)) { depth--; if (depth === 0) return k + 1 }
                }
                break
              }
            }
            return i + 1
          })()
          return { file, line: envEnd, labelLine: i + 1 }
        }
      }
    }

    // 3. Fall back to line:N magic label
    const lineMatch = locLabel.match(/^line:(\d+)$/)
    if (lineMatch) { const ln = parseInt(lineMatch[1]); return { file: project.mainFile, line: ln, labelLine: ln } }

    return null
  }

  const resolved = await resolveLocation(after || before)
  if (resolved === null) {
    return res.status(400).json({
      error: `Cannot resolve location "${after || before}": not a label in the document, and not in line:N format`,
    })
  }

  const targetContent = resolved.file === project.mainFile ? mainContent : await readSourceFileAsync(req.params.name, resolved.file)
  const targetLines = targetContent.split('\n')
  const insertLine = `\\inputscratch{${displayPath}}{${label}}{${displayHeader}}`
  if (after) {
    targetLines.splice(resolved.line, 0, insertLine)
  } else {
    targetLines.splice(resolved.labelLine - 1, 0, insertLine)
  }

  // Ensure preamble references the scratch template file (always in main file).
  const mainLines2 = resolved.file === project.mainFile ? targetLines : mainContent.split('\n')
  const templateInputLine = `\\input{${scratchTemplateRel.replace(/\.tex$/, '')}}`
  // Also detect old-format template lines from before the .tlda/scratch migration
  const oldTemplateInputLine = '\\input{.scratchinputs/scratch-template}'
  const hasTemplateInput = mainLines2.some(l => l.includes(templateInputLine))
  if (!hasTemplateInput) {
    const oldScratchLines = ['\\usepackage{xcolor}', '\\providecommand{\\inputscratch}', '\\newenvironment{scratch}', '\\renewenvironment{scratch}']
    for (let i = mainLines2.length - 1; i >= 0; i--) {
      if (oldScratchLines.some(prefix => mainLines2[i].trimStart().startsWith(prefix))) {
        mainLines2.splice(i, 1)
      }
      // Replace old-format template input with new path
      if (mainLines2[i] && mainLines2[i].includes(oldTemplateInputLine)) {
        mainLines2[i] = templateInputLine
      }
    }
    // Re-check after old-format replacement
    if (!mainLines2.some(l => l.includes(templateInputLine))) {
      const beginDocIdx = mainLines2.findIndex(l => /\\begin\{document\}/.test(l))
      const insertAt = beginDocIdx >= 0 ? beginDocIdx : 0
      mainLines2.splice(insertAt, 0, templateInputLine)
    }
  }

  res.json({
    ok: true,
    scratchPath,
    sourcePath,
    wrappedContent,
    scratchTemplatePath,
    scratchTemplateContent,
    mainFile: project.mainFile,
    mainContent: mainLines2.join('\n'),
    targetFile: resolved.file !== project.mainFile ? resolved.file : undefined,
    targetContent: resolved.file !== project.mainFile ? targetLines.join('\n') : undefined,
    insertedAt: resolved.line,
    action: after ? 'inserted-after' : 'inserted-before',
  })
})

// POST /:name/inline-scratch — promote a polished scratch section into the document
// Strips the scratch wrapper and replaces \inputscratch{} with the bare content in main.tex.
router.post('/:name/inline-scratch', requireRw, async (req, res) => {
  const { label } = req.body
  if (!label) return res.status(400).json({ error: 'label is required' })

  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  if (!project.mainFile) return res.status(400).json({ error: 'Project has no mainFile' })

  const mainContent = await readSourceFileAsync(req.params.name, project.mainFile)
  if (!mainContent) return res.status(400).json({ error: `Main file not found: ${project.mainFile}` })

  const filename = label.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.tex'
  const mainDir = dirname(project.mainFile)
  const scratchRel = `.tlda/scratch/${filename}`
  const scratchPath = mainDir !== '.' ? join(mainDir, scratchRel) : scratchRel

  const scratchContent = await readSourceFileAsync(req.params.name, scratchPath)
  if (!scratchContent) return res.status(404).json({ error: `Scratch file not found: ${scratchPath} — has it been synced to the server yet?` })

  // Content is raw (no wrapper) — just trim trailing blank lines
  const innerLines = scratchContent.split('\n')
  while (innerLines.length > 0 && innerLines[innerLines.length - 1] === '') innerLines.pop()

  // Replace \inputscratch{...}{label}{...} line in main.tex with the bare content
  const mainLines = mainContent.split('\n')
  const scratchLineIdx = mainLines.findIndex(l => l.includes(`\\inputscratch`) && l.includes(`{${label}}`))
  if (scratchLineIdx < 0) {
    return res.status(404).json({ error: `Cannot find \\inputscratch with label {${label}} in ${project.mainFile}` })
  }

  const newLines = [...mainLines]
  newLines.splice(scratchLineIdx, 1, ...innerLines)

  res.json({
    ok: true,
    mainFile: project.mainFile,
    mainContent: newLines.join('\n'),
    scratchPath,
  })
})

// GET /:name/shadow/log — list shadow commits with hashes and timestamps
router.get('/:name/shadow/log', requireRead, async (req, res) => {
  const repoDir = join(getProjectDir(req.params.name), 'shadow-repo')
  try {
    const { stdout: log } = await execFileAsync(
      'git',
      ['log', '--format=%H %aI', '--max-count=500'],
      { cwd: repoDir, encoding: 'utf8', timeout: 5000 },
    )
    const commits = log.trim().split('\n').filter(Boolean).map(line => {
      const [hash, ts] = line.split(' ')
      return { hash: hash.slice(0, 7), timestamp: ts }
    })
    res.json({ commits })
  } catch {
    res.json({ commits: [] })
  }
})

export default router
