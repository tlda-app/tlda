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
 *   POST   /:name/build         Trigger rebuild
 *   GET    /:name/build/status  Build status + log
 */

import express, { Router } from 'express'
import { execFile } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { access, mkdir, readFile, readdir, rm, unlink, writeFile } from 'fs/promises'
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'fs'
import { join, basename, dirname, resolve } from 'path'
import { tmpdir } from 'os'
import { promisify } from 'util'
import { requireRead, requireRecordingPrivateRead, requireRw } from '../lib/auth.mjs'
import {
  createProject, readProject, updateProject, listProjects, deleteProject,
  readProjectMeta,
  listSourceFiles, hashSourceFiles, readSourceFileAsync, writeSourceFileAsync, deleteSourceFileAsync, readBuildLogAsync, sourceDir as getSourceDir, outputDir as getOutputDir,
  extractBuildErrors, extractPipelineWarningsAsync, addBookMember, getProjectsDir, projectDir as getProjectDir,
  projectPartsRoot, readProjectPartsManifest, writeProjectPartsManifest, referencedSourcePaths,
  listDocumentAssociations,
  isClientOwnedSourcePath, readClientSourceManifest, validateSourceFilePath,
  beginProjectSourceTransaction,
  updateClientSourceManifest,
  sourceLifecycleStore,
  checkpointProjectPartWritebackOffloop,
} from '../lib/project-store.mjs'
import { changedTextRegions } from '../lib/changed-text-regions.mjs'
import { projectRevisionStatus, SOURCE_AUTHORITY_UNINITIALIZED } from '../lib/source-lifecycle.mjs'
import { emitSourceEditEvent } from '../lib/source-edit-event.mjs'
import { dispatchBuild, isBuildKindPending } from '../lib/build-dispatch.mjs'
import { outlineForRegion, regionFromSpan, structuralLeaves } from '../lib/outline/outline.mjs'
import { buildModel, assertRoundTrip } from '../lib/outline/model.mjs'
import { findTextNearSourceLine, sourceTextSpanToPdfSpans } from '../lib/synctex-query.mjs'
import { compareHighlightFeedbackBySource, highlightFeedbackFromShape } from '../lib/highlight-feedback.mjs'
import { realizeProjectMarkdownArtifact, writeProjectMarkdownArtifact } from '../lib/project-artifact-materializer.mjs'
import { TASK_DOC_FILENAME, TASK_DOC_PROJECT_ID, STATUS_TASK_DOC_ROW_LIMIT, materializeTaskDocs } from '../lib/task-doc-materializer.mjs'
import { markdownColumnFileForSource, listProjectPartColumns, pageInfoFromDocumentColumns } from '../lib/document-columns.mjs'
import { clipRecordingData, readRecordingPublication, writeOwnerInterval, writePublishedRecording } from '../lib/recording-publication.mjs'
import { materializeRecordingAudioClip } from '../lib/recording-audio-clip.mjs'
import { shouldBuildOnPush } from '../lib/build-decision.mjs'
import { isManagedSourcePath, normalizeSourceManifest, referencedRootsFromPaths, sourceManifestContext } from '../../shared/source-manifest.mjs'
import historyRoutes from './history.mjs'
import { linkOverleaf, unlinkOverleaf, syncOverleaf, prepareSourcePushToOverleaf, recoverProjectSourceTransactions, readOverleafLocalHead, stopPolling, isPolling } from '../lib/overleaf-sync.mjs'
import { getRoomRecords, getRecord, putShape, updateShape, deleteShape, onShapeChange, getOrCreateRoom, broadcastSignal, getLastSignal, onSignal, replaceRoomSnapshot, getShapesAt, emitGlobalEvent, onGlobalEvent } from '../lib/sync-rooms.mjs'
import { getFleetServerUrl, getServerUrl } from '../../shared/config.mjs'
import { FORMATS_WITH_OWN_PAGE_INFO } from '../../shared/document-formats.mjs'
import { gitBlobId } from '../../shared/git-blob-id.mjs'
import { writeSentinel } from '../lib/sentinel.mjs'
import { scanMarkdownDeps } from '../../shared/markdown-deps.mjs'
import { readSharedDocumentThroughOwner } from '../lib/document-association-sources.mjs'
import { readShadowChangelog, readShadowIndexInfo } from '../lib/shadow-changelog.mjs'
import { clearSourceSyncConflicts, clearSourceSyncRefusal, recordSourceSyncConflicts, recordSourceSyncRefusal, sourceConflictOwner } from '../lib/source-sync-conflicts.mjs'

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
export async function listProjectsWithLifecycleStatus() {
  return Promise.all((await listProjects()).map(async project => {
    const durableStatus = projectRevisionStatus((await sourceLifecycleStore(project.name)).listRevisionLifecycles(project.name))
    return {
      ...project,
      buildStatus: durableStatus.status,
      buildPhase: durableStatus.phase,
      sourceRevision: durableStatus.sourceRevision,
      acceptSeq: durableStatus.acceptSeq,
    }
  }))
}

router.get('/', requireRead, async (req, res) => {
  res.json({ projects: await listProjectsWithLifecycleStatus() })
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

  const durableStatus = projectRevisionStatus((await sourceLifecycleStore(req.params.name)).listRevisionLifecycles(req.params.name))
  // The chat-reference seed of project membership. This is the payload the
  // watcher already reads its source context from, so the roots arrive by the
  // channel that already carries mainFile rather than a second call.
  res.json({
    ...project,
    buildStatus: durableStatus.status,
    buildPhase: durableStatus.phase,
    sourceRevision: durableStatus.sourceRevision,
    acceptSeq: durableStatus.acceptSeq,
    referencedSourcePaths: await referencedSourcePaths(req.params.name).catch(() => []),
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
router.delete('/:name/parts', requireRw, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  const ids = Array.isArray(req.body?.ids)
    ? [...new Set(req.body.ids.map(id => String(id || '').trim()).filter(Boolean))]
    : []
  if (!ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' })

  const root = projectPartsRoot(req.params.name)
  const manifest = await readProjectPartsManifest(req.params.name)
  const byId = new Map(manifest.parts.map(part => [part.id, part]))
  const missing = ids.filter(id => !byId.has(id))
  if (missing.length) return res.status(404).json({ error: 'Part not found', missing })

  for (const id of ids) {
    const part = byId.get(id)
    const targetPath = String(part.path || part.storage?.path || '')
    if (targetPath && !targetPath.startsWith('/') && !targetPath.split('/').includes('..')) {
      const localPath = join(root, targetPath)
      if (await pathExists(localPath)) await rm(localPath)
    }
  }
  const deleted = new Set(ids)
  await writeProjectPartsManifest(req.params.name, {
    ...manifest,
    parts: manifest.parts.filter(part => !deleted.has(part.id)),
  })
  if (project.format === 'markdown') {
    await dispatchBuild(req.params.name)
  } else if (!FORMATS_WITH_OWN_PAGE_INFO.has(project.format)) {
    await dispatchBuild(req.params.name, { kind: 'parts' })
  }
  res.json({ ok: true, deleted: ids })
})

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
  const { add, members } = req.body
  // A full-set REPLACE, because the additive form cannot express a removal:
  // looping `add` over a caller's intended set silently makes a dropped member
  // permanent. The existing `add` branch below is untouched and its four
  // callers keep working.
  if (Array.isArray(members)) {
    if (!members.every(member => typeof member === 'string')) {
      return res.status(400).json({ error: 'members must be an array of strings' })
    }
    const project = await readProject(req.params.name)
    if (!project) return res.status(404).json({ error: 'Project not found' })
    // 400 on a non-book project. The `/push` branch that carries `members`
    // today is guarded on `format === 'book'` and FALLS THROUGH to a normal
    // source push when it is not -- so a members array sent to a non-book
    // project silently becomes a file push with an empty file list. This is
    // the error behaviour of new code, not a change to shipped behaviour.
    if (project.format !== 'book') {
      return res.status(400).json({ error: 'members can only be replaced on a book project' })
    }
    try {
      await updateProject(req.params.name, { members })
      res.json({ ok: true, members })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
    return
  }
  if (!add || typeof add !== 'string') return res.status(400).json({ error: 'add member name or members[] required' })
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
  try { res.json(await (await sourceLifecycleStore(req.params.name)).readAuthority()) }
  catch (e) { res.status(404).json({ error: e.message }) }
})

/**
 * The current revision's entries: `{path, sha256, size}` per file.
 *
 * **This is what makes an incremental push expressible on the JSON carrier.**
 * The carrier requires a complete manifest, and a path may be given either as
 * content or as a carried-forward reference — but a client can only build the
 * reference if it can learn the store's blob id for a file it is NOT sending.
 * Nothing exposed one: `GET /:name/hashes` returns MD5 of the server's working
 * files, which is a different value in a different space.
 *
 * Without this, four CLI sites whose manifest is deliberately wider than their
 * `files` -- the ones carrying `preservedServerPaths`, or pruning stale paths
 * with `files: []` -- can only comply by sending the whole project on every
 * push. On the 1492-file classroom book that is every file on every flush,
 * against a 20MB batch ceiling. The alternative to this route is not a slower
 * push, it is no incremental push.
 */
router.get('/:name/source-entries', requireRead, async (req, res) => {
  try {
    const lifecycle = await sourceLifecycleStore(req.params.name)
    const { currentRevision } = await lifecycle.readAuthority()
    if (!currentRevision) return res.json({ ok: true, sourceRevision: null, files: [] })
    const record = await lifecycle.readRevision(currentRevision)
    res.json({ ok: true, sourceRevision: currentRevision, files: record?.files || [] })
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message })
  }
})

/**
 * The commits a proposer lacks, so that a refusal is recoverable.
 *
 * **Without this the 409 is a dead end that reads as working.** A refusal names
 * `currentRevision`, and the proposer is told to rebase onto it -- but it cannot
 * rebase onto a commit whose objects it does not have, and the accept that beat
 * it is by definition somebody else's commit. The replica fan-out does not close
 * this: it ships blobs and manifests, not git objects.
 *
 * The mirror does eventually deliver the objects, on accept, to every bound
 * checkout. That is a race, not a mechanism: the 409 can arrive first, and a
 * recovery path that works only when it loses the race is the shape this
 * replacement exists to remove. So the proposer asks, and is answered now.
 *
 * `have` is what the proposer holds, so the bundle is `have..source` -- and it
 * carries the refused ref too, because a proposer that wants to show somebody
 * what was refused needs the commit, not the sha.
 */
router.get('/:name/source-bundle', requireRead, async (req, res) => {
  try {
    const lifecycle = await sourceLifecycleStore(req.params.name)
    const payload = await lifecycle.proposerBundle(req.query.have || null)
    if (!payload) return res.status(404).json({ ok: false, error: 'the project has no accepted revision' })
    res.json({ ok: true, ...payload })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

// Read a specific source file's content
router.get('/:name/source/:file', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  try {
    const current = await (await sourceLifecycleStore(req.params.name)).readCurrentFile(req.params.file)
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
// Four different conditions used to answer 200 {macros:{}} here: no such
// project, no macros artifact yet, an unparseable artifact, and a document
// whose preamble genuinely defines nothing. The caller could not tell them
// apart, so a failure arrived as the fact "this document has no macros" -- and
// the chat lint then reported that to an agent as "you have no project
// preamble set", which sent Skip to set a preamble that was already set.
//
// An empty body is now only ever the last of the four: a document that really
// has no macros. Everything else says what went wrong.
router.get('/:name/macros', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: `No project "${req.params.name}"` })
  const texBase = (project.mainFile || 'main.tex').replace(/\.tex$/, '').split('/').pop()
  const outputPath = join(getOutputDir(req.params.name), `${texBase}-macros.json`)
  // Not built yet is not "no macros": the preamble is unknown until a build has
  // produced the artifact, and a document that has never been built is the case
  // most likely to be read as "you have no preamble".
  if (!await pathExists(outputPath)) {
    return res.status(404).json({ error: `No macros artifact for "${req.params.name}" — the project has not been built yet` })
  }
  try {
    const data = JSON.parse(await readFile(outputPath, 'utf8'))
    res.json({ macros: data.macros || {} })
  } catch (e) {
    res.status(500).json({ error: `Macros artifact for "${req.params.name}" is unreadable: ${e.message}` })
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

function conflictFilesFromLifecycleResult(result) {
  const classifications = result?.evidence?.classifications
  if (!Array.isArray(classifications)) return []
  return classifications
    .filter(item => item?.status === 'conflict' && typeof item.path === 'string')
    .map(item => item.path)
}

let acceptedSourceMutationHandler = null
let pendingSourceReplicaHandler = null
let sourceBindingTargetProvider = null

export function setAcceptedSourceMutationHandler(handler) {
  acceptedSourceMutationHandler = typeof handler === 'function' ? handler : null
}

let acceptedRevisionMirrorHandler = null

export function setAcceptedRevisionMirrorHandler(handler) {
  acceptedRevisionMirrorHandler = typeof handler === 'function' ? handler : null
}

/**
 * Send an accepted revision to the machines holding this project, so the
 * author's checkout gains a commit for work the server has just accepted.
 *
 * **The trigger is the accept, not a build.** Before this, the only caller of
 * the mirror was the tail of a successful build, so a paper that failed to
 * build was a paper whose author's disk was never committed — which is how
 * three hours of somebody's prose came to exist only in a working directory on
 * 2026-08-18.
 *
 * It does not run inside the push transaction and its failure never rejects a
 * push: the revision is accepted and durable either way, and a machine that is
 * asleep is not a reason to refuse somebody's writing. `refs/tlda/mirrored`
 * advances only when a daemon actually took it, so a failed attempt leaves the
 * next accept bundling from the same older basis rather than assuming this one
 * landed.
 */
// One mirror at a time per project.
//
// Without this, two mirrors for the same project run concurrently — they are
// kicked off per accepted push and never awaited — and they collide inside
// `preserveAuthorCommit` on the author's real git index. The later one finishes,
// commits, and its `refreshRealIndex` points the index at ITS blobs; the earlier
// one then reaches `validateTargetIndex`, finds an index matching neither the
// HEAD it captured at the start nor its own shadow entry, and refuses with
// `staged <file> differs from shadow`.
//
// **The refusal looks exactly like the author having staged something, and they
// have not.** By the time anyone looks, the winner has finished and
// `git diff --cached` is empty — which is what made this hard to see from
// outside. That guard is correct and stays; it just must not be handed a race
// to adjudicate.
const projectMirrorQueues = new Map()

async function serializeProjectMirror(name, run) {
  const previous = projectMirrorQueues.get(name) || Promise.resolve()
  let release
  const current = new Promise(resolve => { release = resolve })
  projectMirrorQueues.set(name, current)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (projectMirrorQueues.get(name) === current) projectMirrorQueues.delete(name)
  }
}

/**
 * What the accept path owes a revision after it has taken it.
 *
 * The old push route does four things past the commit: it mirrors to the
 * author's checkout, fans the revision out to other bound checkouts, dispatches
 * a build, and clears the stuck-marks of whoever's work just landed. An accept
 * that does none of them is a green path with the work silently not happening,
 * which is the failure the replacement exists to remove.
 *
 * **Derived, not declared.** The old path is handed `files: [{path, content}]`
 * and builds the replica payload from it. A bundle carries a tree and no list,
 * so the changed set comes from `diffRevisions` — the same property that makes
 * the tree authoritative makes the list unavailable.
 *
 * **The journal entry comes first and is not optional.** `recordReplicaTargets`
 * throws for a revision it has never seen accepted, and `acceptBundle` moves
 * the ref without touching the journal, so the registration below is the thing
 * that makes a bundle-accepted revision addressable by every phase after it.
 *
 * Returns which effects ran, so the response can say so rather than implying
 * it. A caller reading `ok: true` cannot otherwise distinguish an accept that
 * preserved the work from one that dropped it on the floor.
 */
/**
 * Run an accept under the operation journal, so a retry cannot land twice.
 *
 * **This is the wrapper promise, and it had exactly one caller.**
 * `prepareOperation` / `finishOperation` were reached only from inside
 * `processProjectPushSerialized`, so the new carriers had no dedup, no
 * crash-safe replay, and no record that an operation was ever attempted.
 * Deleting the old path without moving this is the one way this cut ends worse
 * than it started: the app looks fine, and a guarantee that survived a crash
 * quietly does not exist any more.
 *
 * A retried push is not hypothetical — a client that times out and resends is
 * the ordinary case, and landing it twice means two revisions where the author
 * made one edit.
 *
 * Carrier-neutral for the same reason the effects are: one implementation, or
 * the copies diverge.
 */
export async function acceptUnderOperationJournal(name, lifecycle, payload, run, { crashAt = null } = {}) {
  const requestId = typeof payload?.requestId === 'string' && payload.requestId.trim() ? payload.requestId : null
  // No requestId means the caller is not asking for idempotency, which is the
  // daemon's case: it holds the change and re-proposes rather than retrying.
  if (!requestId) return run()

  const prepared = lifecycle.prepareOperation({ project: name, ...payload })
  // A request id reused with a DIFFERENT payload is a caller bug, not a retry,
  // and answering it with the first result would silently discard the second
  // edit. It is refused by name.
  if (prepared.invalidReuse) return { ...prepared.result, replayed: true, invalidReuse: true }
  // A replay hands back the SAME terminal result the journal stored, which is
  // the fact a caller needs: not that it replayed, but what the canonical
  // answer was.
  if (prepared.result) return { ...prepared.result, replayed: true, operationResult: prepared.result }

  const result = await run()

  // **The first crash boundary: the revision is durable and the journal is
  // not.** A process dying here has accepted the work and recorded no terminal
  // result — the case the durability promise is actually about.
  //
  // Taken as an argument rather than off the request body, so a remote caller
  // cannot ask a server to pretend to crash.
  if (crashAt === 'after-accept') return { ...result, simulatedCrash: true, crashedAt: crashAt }

  const authority = await lifecycle.readAuthority()
  const sourceRevision = result?.revision?.id ?? result?.revision ?? null
  // Which edit operations this revision carried. They are a real property of
  // the accepted mutation rather than bookkeeping: after a crash, this is how
  // anyone can tell WHICH agent's edit the surviving revision contains.
  const editOperations = payload?.editOperations
    || (payload?.editOperation ? [{ agentId: payload?.editedBy || null, operation: payload.editOperation }] : [])
  const operationResult = {
    ok: !!result?.ok,
    httpStatus: result?.ok ? 200 : 409,
    lifecycleStatus: result?.status ?? null,
    requestId,
    sourceRevision,
    acceptSeq: authority.acceptSeq,
    disposition: result?.ok ? 'accepted' : 'rejected',
    operationIds: editOperations.map(record => record.operation?.operation_id).filter(Boolean),
  }
  lifecycle.finishOperation(name, requestId, result?.ok ? 'accepted' : 'rejected', operationResult, {
    acceptSeq: authority.acceptSeq,
    acceptedRevision: result?.ok ? sourceRevision : null,
    orderedEffects: result?.ok
      ? [{ type: 'accepted-source-mutation', acceptSeq: authority.acceptSeq, editOperations }]
      : [],
  })

  // **The second boundary: the journal is durable and the effects have not
  // run.** A crash here must leave the request replayable with the same
  // canonical result, which is what makes the effects safe to be
  // fire-and-forget.
  if (crashAt === 'after-terminal-result') {
    return { ...result, simulatedCrash: true, crashedAt: crashAt, operationResult }
  }
  return { ...result, operationResult }
}

/**
 * Bring the server's working copy to a revision, idempotently.
 *
 * Separate and callable because it has to run in two places: after an accept,
 * and after a REPLAY whose accept happened in a process that died before
 * getting here. A replay deliberately returns before the effects — it must not
 * re-mirror or re-dispatch a build — but the document still has to be on disk,
 * and nothing else will ever put it there.
 *
 * Driven by `refs/tlda/materialized/<project>`, which is what the disk holds
 * rather than what it should hold. A null ref means the whole manifest: not a
 * diff, because `diffRevisions(null, head)` returns nothing despite its
 * `--root` branch — measured, and the reason an earlier version of this fix
 * looked right and changed nothing.
 */
async function materializeWorkingCopy(name, lifecycle, sourceRevision) {
  const accepted = await lifecycle.readRevision(sourceRevision)
  const onDisk = await lifecycle.lastMaterialized().catch(() => null)
  if (onDisk === sourceRevision) return true
  const { changed: writePaths, deleted: removePaths } = onDisk
    ? await lifecycle.diffRevisions(onDisk, sourceRevision)
    : { changed: accepted?.manifest || [], deleted: [] }
  for (const file of writePaths) {
    const bytes = await lifecycle.readRevisionFile(sourceRevision, file)
    if (bytes) await writeSourceFileAsync(name, file, bytes)
  }
  for (const file of removePaths) await deleteSourceFileAsync(name, file)

  // **And the file LIST**, which is a table rather than a scan of the disk.
  // `project-store.mjs` refuses to store it any other way, so correct bytes
  // with no row is a file that is right on disk and does not appear in the
  // project at all -- invisible to `listSourceFiles` and to anything that
  // enumerates rather than reading a path it already knows.
  if (accepted?.manifest) await updateClientSourceManifest(name, accepted.manifest)

  // Only now, so a crash before this leaves the ref behind the accept and the
  // next attempt writes what the disk is missing.
  await lifecycle.markMaterialized(sourceRevision, onDisk).catch(error => {
    // Not fatal: the bytes are on disk, which is what the author needs. A stale
    // ref costs a redundant write next time, never a missing file.
    console.error(`[${name}] could not record the materialized revision: ${error.message}`)
  })
  return true
}

/**
 * The six post-accept effects, for EVERY carrier.
 *
 * Exported and carrier-neutral on purpose. Four carriers reach this accept --
 * the daemon bundle POST, the JSON carrier, the room checkpoint and the
 * Overleaf remote pull -- and only the first has a bundle. Bolting the effects
 * to the bundle route means the other three either lose them or grow copies,
 * and an enumerated list in N places does not stay one list:
 * `passthroughConfigEnv` exists four times in this repo and has already
 * diverged.
 *
 * So this is the one implementation, and it takes a revision rather than a
 * carrier.
 *
 * **`postAcceptEffects` names what RAN, not what was requested**, which is why
 * it is an array rather than a boolean — *the accept worked* and *the work was
 * preserved* are different facts and a caller cannot see the second. The
 * consequence for callers: a field that used to describe an intention now
 * describes an outcome, and the two agree until they do not. A caller reading
 * `building` to decide whether to say "build queued" is reading whether a build
 * was actually dispatched, so on an accept where it was not, the honest answer
 * is that it was not — silently showing the less informative of two true
 * strings is the least visible way to get this wrong.
 */
export async function applyAcceptedSourceEffects(name, lifecycle, {
  sourceRevision, acceptSeq, previousRevision, editedBy, sourceBindingId, requestId,
  // Which daemon's push this was, so the fan-out can avoid echoing the change
  // back to the machine it came from. Absent means "tell everyone", which is
  // correct for a carrier that is not a daemon.
  sourceDaemonKey = null,
  // **The identity, computed ONCE by the caller and passed to both sides.**
  //
  // The ledger is keyed by owner, and the write side and the clear side have to
  // agree about what an owner is. They did not: the refusal was recorded from
  // the full identity while the clear was handed a bare `editedBy` string --
  // and `sourceConflictOwner` reads `.editedBy`/`.machineId` OFF that string,
  // gets `undefined` for every one, and returns `{id: 'unknown'}`. The key was
  // `unknown`, so it matched no row and the refusal was never cleared: a person
  // reported stuck after their work arrived, and an alarm that never clears is
  // one nobody reads.
  //
  // Taking it as a value rather than re-deriving it here is what makes the two
  // sides unable to disagree.
  owner = null,
}) {
  if (!sourceRevision) return []
  const ran = []
  lifecycle.recordAcceptedRevision(name, sourceRevision, acceptSeq)
  ran.push('journal')

  const { changed, deleted } = await lifecycle.diffRevisions(previousRevision, sourceRevision)

  const targets = await sourceBindingTargetsForProject(name, sourceBindingId)
  if (targets.length) {
    // `readRevision` is async since revisions became commits. Unawaited it
    // yields a Promise, `?.files` is undefined, and BOTH manifests arrive as
    // `[]` -- so the materializer plans a union of two empty sets, finds no
    // paths, and applies nothing. The registration succeeds, the response says
    // `replicas`, and no checkout receives the change: a green path with the
    // work silently not happening, which is the sentence this function's own
    // comment was written against.
    const targetRevision = await lifecycle.readRevision(sourceRevision)
    const baseRevision = previousRevision ? await lifecycle.readRevision(previousRevision) : null
    const blobs = {}
    // **The files carry their CONTENT, not just their paths.**
    //
    // Two consumers read this payload and only one reads `blobs`. The daemon's
    // materializer looks bytes up by blob id; the source ROOM reads
    // `file.content` directly -- `bufferFromBase64(file.content)`. Send
    // `{path}` alone and the room finds the entry, gets `undefined`, and merges
    // an EMPTY STRING against its own text: somebody's accepted paragraph
    // arrives as nothing.
    //
    // Nothing surfaces it. The merge succeeds -- it merges emptiness -- so the
    // fan-out reports applied and the accept reports accepted while the room
    // holds the wrong text. Both ends contain `files`, so every grep is
    // healthy: the reconstruction hazard with the payload itself as the field
    // that vanished.
    const changedFiles = []
    for (const path of changed) {
      const bytes = await lifecycle.readRevisionFile(sourceRevision, path)
      if (!bytes) continue
      // Keyed by git's blob id, because that is what the manifest entries name
      // and what `source-materializer.mjs` looks the bytes up by -- its `hash`
      // is `gitBlobId`. Keyed by sha256 the lookup misses and the apply throws
      // `Missing blob`, on the far side, after the accept has been reported.
      blobs[gitBlobId(bytes)] = bytes.toString('base64')
      changedFiles.push({ path, content: bytes.toString('base64'), encoding: 'base64' })
    }
    lifecycle.recordReplicaTargets(name, sourceRevision, targets, {
      project: name,
      sourceRevision,
      previousRevision,
      files: changedFiles,
      deletedFiles: deleted,
      sourceBindingId: sourceBindingId || null,
      requestId: requestId || null,
      baseManifest: baseRevision?.files || [],
      targetManifest: targetRevision?.files || [],
      blobs,
    })
    ran.push('replicas')

    // **Recording a replica is not sending it.**
    //
    // `recordReplicaTargets` writes the pending rows; `acceptedSourceMutationHandler`
    // is what reads them and sends `apply-source-update` to each daemon. The old
    // path reached it by tagging its result with `acceptedSourceMutation`, which
    // `runSerializedProjectSourceOperation` notices on the way out. This path
    // cannot use that hook: the serialized operation returns BEFORE the effects
    // run, so the handler would fire while there is nothing recorded to send.
    //
    // Left alone, every carrier records replicas that nothing dispatches — so no
    // linked machine is ever told the paper moved, with no error anywhere. That
    // is not Overleaf-specific and not carrier-specific; it is every push. A
    // person's laptop simply stops receiving their own edits.
    //
    // Fire-and-forget, like the mirror and the build: a sleeping machine is not
    // a reason to tell an author their writing did not land.
    if (acceptedSourceMutationHandler) {
      void Promise.resolve().then(() => acceptedSourceMutationHandler({
        project: name,
        sourceRevision,
        previousRevision,
        files: changedFiles,
        deletedFiles: deleted,
        sourceManifest: targetRevision?.files?.map(entry => entry.path) || [],
        sourceDaemonKey: sourceDaemonKey || null,
        sourceBindingId: sourceBindingId || null,
        requestId: requestId || null,
      })).catch(error => console.error(`[${name}] accepted source replica dispatch failed: ${error.message}`))
      ran.push('replica-dispatch')
    }
  }

  // **The server's own working copy.** Everything that reads a project's source
  // as FILES reads it from here: the build pipeline, `listSourceFiles`,
  // `hashSourceFiles`, and `GET /:name/source/:file` -- which is the source
  // editor's read, the surface Skip edits his paper on.
  //
  // The mirror does not cover this. It sends the revision to the DAEMON's
  // checkout, on his machine. Without the write below, a push is accepted, the
  // revision is recorded, `acceptSeq` moves, the response says the work is
  // preserved, and the document on this disk never changes -- so the build
  // renders stale content and the editor reads stale content. He would
  // experience it as editing his paper, being told it synced, and the paper not
  // changing.
  //
  // It is written from the accepted revision rather than from the request,
  // because the revision is what was accepted -- a carried-forward path and a
  // clean rebase both differ from what the caller sent.
  let materialized = true
  try {
    await materializeWorkingCopy(name, lifecycle, sourceRevision)
    ran.push('working-copy')
  } catch (error) {
    materialized = false
    console.error(`[${name}] writing the working copy after accept failed: ${error.message}`)
  }

  // **Ask whether to build, rather than always building.**
  //
  // The old path asked `shouldBuildOnPush` and suppressed for `unchanged`,
  // `outside-tree`, `already-building` and a failed relevant-files parse. This
  // path dispatched unconditionally, so the difference is not new behaviour
  // appearing — it is a suppression that stopped happening.
  //
  // `already-building` is the one that bites: without it a project being edited
  // continuously stacks a build worker per accept, on a box this fleet has
  // already taken down once. Each of those workers also outlives the accept
  // that spawned it, which is how an accept that completed can look like one
  // that hung.
  //
  // Still gated on the working copy, because a build over bytes we failed to
  // write publishes a render of the PREVIOUS revision under this one's number —
  // worse than no build, which at least leaves the old output honest.
  const project = await readProject(name)
  const decision = shouldBuildOnPush(project, name, {
    changedFiles: [...changed, ...deleted],
    anyChanged: changed.length > 0 || deleted.length > 0,
    building: isBuildKindPending(name, 'build'),
    ready: projectRevisionStatus(lifecycle.listRevisionLifecycles(name)).status === 'success',
  })
  if (materialized && decision.build) {
    void dispatchBuild(name, { sourceRevision, acceptSeq })
      .catch(error => console.error(`[${name}] build dispatch after accept failed: ${error.message}`))
    ran.push('build')
  } else if (sourceRevision) {
    // A revision that correctly did not build still says so. Without these a
    // suppressed build is indistinguishable from one that never got dispatched.
    const terminalState = decision.reason === 'already-building' ? 'superseded' : 'not_required'
    lifecycle.recordRevisionPhase(name, sourceRevision, 'build', terminalState, { reason: decision.reason })
    lifecycle.recordRevisionPhase(name, sourceRevision, 'version', 'not_reached', { buildState: terminalState })
    ran.push(`build-skipped:${decision.reason}`)
  }

  // **The mirror: server -> every bound checkout. This is the return direction,
  // and it had NO CALLER AT ALL.**
  //
  // Both of its call sites lived inside `processProjectPush` and died with it in
  // `a51b2505e`. The build tail's copy was deleted separately, correctly, on the
  // reasoning that the accept drives the mirror -- and the accept did not. So
  // between those two commits the return direction was off for every project on
  // the box: pushes landed, nothing came back, and every grep for
  // `mirrorAcceptedRevision` found three healthy-looking occurrences that were
  // its definition, its delegation, and a test calling it directly.
  //
  // The accept IS the right place and the build-tail deletion was right.
  // `build-runner.mjs:1693` says why: a paper that fails to build is still a
  // paper worth mirroring, so making the mirror wait on a build means a broken
  // document stops reaching the machines that could fix it.
  //
  // Fire-and-forget, like the build and the replica dispatch: a sleeping laptop
  // is not a reason to tell an author their writing did not land.
  if (sourceRevision) {
    void mirrorAcceptedRevision(name, lifecycle, sourceRevision, acceptSeq)
      .catch(error => console.error(`[${name}] mirroring accepted revision ${String(sourceRevision).slice(0, 7)} failed: ${error.message}`))
    ran.push('mirror')
  }

  // Whoever's work reached the paper is no longer stuck, whichever files it was.
  try {
    const clearFor = owner || sourceConflictOwner({ editedBy, sourceDaemonKey, sourceBindingId })
    await clearSourceSyncConflicts(name, [...changed, ...deleted], clearFor)
    if (editedBy || sourceDaemonKey) await clearSourceSyncRefusal(name, clearFor)
    ran.push('cleared-conflicts')
  } catch (error) {
    // Derived state. It must not unwind an accept that already happened.
    console.error(`[${name}] clearing sync conflicts after bundle accept failed: ${error.message}`)
  }

  // The edit event, which carries line-level regions rather than filenames.
  //
  // The old push route has these handed to it: it was given the file contents,
  // so it knows what moved inside each one. **A bundle carries a tree and no
  // regions**, so this path derives them the same way it derives `changed` --
  // by asking git for both sides and diffing them. Dropping the event instead
  // would leave the accept correct and the attribution silently gone, which is
  // not a smaller failure than dropping the mirror, only a quieter one.
  if (editedBy) {
    try {
      const editedFiles = []
      for (const file of changed) {
        if (!file.endsWith('.tex') && !file.endsWith('.md')) continue
        const after = await lifecycle.readRevisionFile(sourceRevision, file)
        const before = previousRevision ? await lifecycle.readRevisionFile(previousRevision, file) : null
        const regions = changedTextRegions(before ? before.toString('utf8') : '', after ? after.toString('utf8') : '')
        if (regions.length) editedFiles.push({ path: file, regions })
      }
      if (editedFiles.length) {
        emitSourceEditEvent({
          emit: emitGlobalEvent,
          result: { ok: true, acceptedChangedFiles: editedFiles },
          project: name,
          editedBy,
          requestId: requestId || randomUUID(),
        })
        ran.push('edit-event')
      }
    } catch (error) {
      // Swallowed deliberately: the revision is already accepted and durable at
      // this point, and attribution is derived from it. Letting a diff failure
      // bubble would turn a missing notification into a failed push and tell an
      // author their writing did not land when it did.
      console.error(`[${name}] source edit event after bundle accept failed: ${error.message}`)
    }
  }
  return ran
}

async function mirrorAcceptedRevision(name, lifecycle, sourceRevision, acceptSeq) {
  if (!acceptedRevisionMirrorHandler || !sourceRevision) return
  return serializeProjectMirror(name, () => mirrorAcceptedRevisionNow(name, lifecycle, sourceRevision, acceptSeq))
}

async function mirrorAcceptedRevisionNow(name, lifecycle, sourceRevision, acceptSeq) {
  const payload = await lifecycle.mirrorPayload(sourceRevision)
  if (!payload) return
  const short = sourceRevision.slice(0, 7)
  const previous = await lifecycle.lastMirrored()
  try {
    const result = await acceptedRevisionMirrorHandler({ name, ...payload, sourceRevision, acceptSeq })
    // The ref moves only now, so it names a revision a checkout actually took.
    await lifecycle.markMirrored(sourceRevision, previous)
    lifecycle.recordRevisionPhase(name, sourceRevision, 'mirror', 'mirrored', { result })
    await updateProject(name, { lastMirrorSuccess: new Date().toISOString(), lastMirrorFailure: null })
    await writeSentinel(`doc-${name}`, { timestamp: Date.now(), syncErrorJson: '' })
    console.log(`[mirror] ${name}@${short} ok via ${(result?.mirrored || []).join(', ') || 'no daemon'}`)
  } catch (error) {
    lifecycle.recordRevisionPhase(name, sourceRevision, 'mirror', 'mirror_failed', { error: error.message })
    await updateProject(name, { lastMirrorFailure: { at: new Date().toISOString(), revision: sourceRevision, message: error.message } })
    // `lastMirrorFailure` is read by nothing — no route, no CLI, no client. The
    // surface a person actually sees is SyncErrorPill, which reads
    // `syncErrorJson` off the doc-version sentinel, and the failure path not
    // setting it is how three papers went unmirrored for weeks with every
    // surface reporting health. It moved here with the mirror rather than being
    // left behind attached to a build phase that no longer does this.
    await writeSentinel(`doc-${name}`, {
      timestamp: Date.now(),
      syncErrorJson: JSON.stringify([{ kind: 'sync-error', message: `Not saved to the working copy: ${error.message}` }]),
    })
    console.error(`[mirror] ${name}@${short} failed: ${error.message}`)
  }
}

export function setPendingSourceReplicaHandler(handler) {
  pendingSourceReplicaHandler = typeof handler === 'function' ? handler : null
}

export function setSourceBindingTargetProvider(provider) {
  sourceBindingTargetProvider = typeof provider === 'function' ? provider : null
}

export async function sourceBindingTargetsForProject(name, sourceBindingId = null) {
  const bindingTargets = sourceBindingTargetProvider
    ? await sourceBindingTargetProvider(name)
    : []
  return bindingTargets.filter(target => target.bindingId !== sourceBindingId)
}

export async function runSerializedProjectSourceOperation(name, operation, options = {}) {
  const previous = sourcePushQueues.get(name) || Promise.resolve()
  let release
  const current = new Promise(resolve => { release = resolve })
  sourcePushQueues.set(name, current)
  await previous
  let result
  try {
    result = await operation()
  } finally {
    release()
    if (sourcePushQueues.get(name) === current) sourcePushQueues.delete(name)
  }
  if (result?.ok && result.acceptedSourceMutation && acceptedSourceMutationHandler) {
    void Promise.resolve().then(() => acceptedSourceMutationHandler({
      project: name,
      ...result.acceptedSourceMutation,
      sourceRevision: result.sourceRevision || result.acceptedSourceMutation.sourceRevision,
      sourceDaemonKey: options.sourceDaemonKey || null,
      sourceBindingId: options.sourceBindingId || null,
      requestId: options.requestId || null,
    })).catch(error => console.error(`[${name}] accepted source replica dispatch failed: ${error.message}`))
  }
  return result
}

async function refreshMaterializedPartsFromChangedSources(name, project, changedPushFiles) {
  if (!changedPushFiles.length) return []
  const manifest = await readProjectPartsManifest(name)
  const sourceRoot = getSourceDir(name)
  const changedPartFiles = new Set()

  for (const file of changedPushFiles) {
    const sourcePath = resolve(sourceRoot, file.path)
    // `sourceRoot` is this server's own projects directory; the manifest records
    // where the file lives on the AUTHOR'S machine, because that is what the
    // chat chip carried. Those namespaces are disjoint on any deployment where
    // the server is not the author's laptop, so the equality below never held —
    // measured: with the paths made equal by hand the part rematerializes, and
    // with the real recorded path it stays stale while the same push succeeds.
    //
    // Both sides agree on the project-relative path, which is the coordinate the
    // push already speaks, so match on that tail.
    const relKey = `/${String(file.path).replace(/\\/g, '/')}`
    const matchingParts = manifest.parts.filter(part => {
      const recorded = part.metadata?.sourcePath
      if (typeof recorded !== 'string' || !recorded) return false
      return recorded === sourcePath || recorded.replace(/\\/g, '/').endsWith(relKey)
    })
    for (const part of matchingParts) {
      // Write the part we just identified, by id. Going back through
      // realizeProjectMarkdownArtifact would redo the lookup against the
      // server-side `sourcePath`, fail the same comparison that has just been
      // worked around above, and mint a SECOND column for the same file rather
      // than updating this one — a duplicate that then also goes stale.
      const result = await writeProjectMarkdownArtifact({
        project: name,
        projectArtifactId: part.id,
        markdown: bufferToUtf8(file.content),
        title: part.title,
        provenance: part.metadata?.provenance || {},
      })
      if (result.ready && result.projectPath) changedPartFiles.add(markdownColumnFileForSource(result.projectPath))
    }
  }

  return [...changedPartFiles]
}

async function referencedClosureForPush(name, roots, { files, sourceManifest }) {
  const declared = new Set(Array.isArray(sourceManifest) ? sourceManifest : [])
  const pushed = new Map((files || [])
    .filter(file => typeof file?.path === 'string')
    .map(file => [file.path, file.encoding === 'base64'
      ? Buffer.from(file.content || '', 'base64').toString('utf8')
      : bufferToUtf8(file.content)]))
  const reached = new Set()
  const queue = [...roots]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || reached.has(current) || !declared.has(current)) continue
    reached.add(current)
    if (!/\.(?:md|markdown)$/i.test(current)) continue

    const content = pushed.has(current)
      ? pushed.get(current)
      : await readSourceFileAsync(name, current)
    if (content == null) continue

    const base = resolve('/', dirname(current))
    for (const dep of scanMarkdownDeps(bufferToUtf8(content), base)) {
      if (!dep.abs || dep.ref.startsWith('/') || dep.ref.startsWith('~/')) continue
      const target = dep.abs.replace(/^\/+/, '').replace(/\\/g, '/')
      if (!target || target.startsWith('../') || !declared.has(target)) continue
      if (!reached.has(target)) queue.push(target)
    }
  }

  return [...reached]
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

async function validateSourcePushRequest(name, project, { files, deletedFiles, sourceManifest }, context) {
  const pushFiles = files || []
  const deletes = deletedFiles || []
  if ((pushFiles.length > 0 || deletes.length > 0) && !Array.isArray(sourceManifest)) {
    return { status: 400, ok: false, error: 'sourceManifest is required for source pushes' }
  }

  const validateAuthoredPath = (filePath, label) => {
    if (typeof filePath !== 'string' || !filePath) return `${label} must be a non-empty string`
    try {
      validateSourceFilePath(name, filePath)
    } catch (e) {
      return e.message
    }
    const normalized = normalizeSourceManifest([filePath], context)
    if (normalized.length !== 1 || normalized[0] !== filePath || !isManagedSourcePath(filePath, context)) {
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

  // A file the client declares, which is really sitting in our own source dir,
  // is real — whether or not the stored manifest happens to remember it.
  //
  // Without this the two records the server keeps of its own source set can
  // deadlock a project permanently. The stored manifest is a cache; the source
  // dir is the thing itself. When the cache loses an entry for a file that is
  // still on disk, that file is declared by every push, credited by none, and
  // therefore `extra` forever — and the push it would take to restore the entry
  // is the push being rejected. Nothing client-side can break the loop: the CLI
  // sends only files whose hash differs from the server's, and this one matches,
  // so it is never carried; and the client can read /hashes but not the stored
  // manifest, so it cannot even see the condition. Measured on a live project:
  // 471 declared, 471 in /hashes, 3 that a push would actually carry.
  //
  // Deliberately NOT a walk of sourceRoot. That would make `missing` — the
  // mirror test below — fire for every file on disk the client does not declare,
  // turning this into a rejection in the opposite direction for any client whose
  // walk is narrower than the server's. Crediting only DECLARED files cannot do
  // that, and the arithmetic is the point:
  //
  //   proposed' = proposed ∪ (declared ∩ disk)
  //   missing'  = proposed' − declared = missing ∪ ∅ = missing   (unchanged)
  //   extra'    = declared − proposed' ⊆ extra                   (can only shrink)
  //
  // So this turns rejections into acceptances and can never do the reverse.
  for (const filePath of declared) {
    if (proposed.has(filePath)) continue
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
  return validateSourcePushRequest(name, project, candidate, sourceManifestContext(project))
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

// Trigger rebuild (no file changes)
router.post('/:name/build', requireRw, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

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
    await dispatchBuild(req.params.name)
  } catch (e) {
    console.error(`[api] Build failed for ${req.params.name}: ${e.message}`)
  }
})

// Build status + log
router.get('/:name/build/status', requireRead, async (req, res) => {
  const project = await readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const durableStatus = projectRevisionStatus((await sourceLifecycleStore(req.params.name)).listRevisionLifecycles(req.params.name))
  const buildLog = await readBuildLogAsync(req.params.name)
  const { errors, warnings } = await extractBuildErrors(req.params.name)
  const pipelineWarnings = await extractPipelineWarningsAsync(req.params.name)

  res.json({
    status: durableStatus.status,
    phase: durableStatus.phase,
    sourceRevision: durableStatus.sourceRevision,
    acceptSeq: durableStatus.acceptSeq,
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

  const durableStatus = projectRevisionStatus((await sourceLifecycleStore(req.params.name)).listRevisionLifecycles(req.params.name))

  const { errors, warnings } = await extractBuildErrors(req.params.name)
  const pipelineWarnings = await extractPipelineWarningsAsync(req.params.name)

  res.json({
    building: durableStatus.status === 'building',
    phase: durableStatus.phase,
    status: durableStatus.status,
    sourceRevision: durableStatus.sourceRevision,
    acceptSeq: durableStatus.acceptSeq,
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

// --- Lecture recordings (voice-classroom M1) ---
// Stored under server/projects/{name}/recordings/:
//   {id}.json   — metadata + timestamped stroke/camera events
//   {id}.audio  — raw audio blob (webm/opus or mp4)

function recordingsDir(name) {
  return join(getProjectDir(name), 'recordings')
}

// POST /:name/recording — store metadata + events JSON (audio uploaded separately)
// A checkout proposes a commit, and the server accepts it iff it fast-forwards.
//
// **Nothing calls this yet, and that is deliberate.** The daemon and the server
// version-skew on every deploy in an order nobody chooses, so the half that
// tolerates the new shape ships first, the half that uses it ships second, and
// the old path is deleted third. A change needing both at once is broken for
// whichever window separates them, and both orders have shipped here.
//
// So this is not a second accept path to live beside the first. It is the first
// deploy of three, and if it is still unused a week from now that is a bug.
//
// The body is the bundle's raw bytes rather than base64 in JSON: the thing that
// took a box down was a 33 MB file becoming 44 MB of body, and base64 is a third
// of that inflation for nothing. `express.raw` is already how audio uploads
// arrive here.
/**
 * The same accept, for a carrier that has no git.
 *
 * A browser cannot build a bundle, so the client callers send a complete
 * snapshot as JSON. **Two carriers, one accept** — and specifically one
 * `applyAcceptedSourceEffects`, not a second copy of it. If this path grew its
 * own effects call the two would drift, and the browser carrier would quietly
 * start preserving something different from the daemon carrier.
 */
/**
 * The accept, callable — not a route.
 *
 * **Four carriers reach this accept and only one of them speaks HTTP.** The
 * room checkpoint and the Overleaf remote pull run in-process with the
 * lifecycle store, so making them manufacture a request to talk to their own
 * server is ceremony that buys nothing and costs a second copy of the accept.
 *
 * Everything a carrier must not get wrong lives here once: the operation
 * journal, the carry-forward, the bootstrap/submit routing, the refusal shape,
 * the metadata, and the six effects. A carrier's only job is to deliver bytes.
 *
 * Returns `{ status, body }` rather than writing a response, so an in-process
 * caller reads a value and the route sends it.
 */
export async function acceptSourceSnapshot(name, payload = {}, { crashAt = null } = {}) {
  const {
    files, sourceManifest, expectedRevision = null, dependencyPins = [],
    // Carried deliberately rather than by being remembered. `session` and
    // `sessionAt` ride only on `tlda push` -- the one command Skip types -- and
    // they enter through `incrementalPush`'s `extraBody`, so a reader
    // enumerating the call sites never sees them. Omit them here and session
    // attribution on his own pushes breaks silently, and only there.
    session = null, sessionAt = null, editedBy = null,
    sourceBindingId = null, requestId = null, sourceDaemonKey = null,
  } = payload
  // `sourceDir` is NOT carried. It is already dropped by the old destructure and
  // every server use reads `project.sourceDir` from storage, so the cross-server
  // move has been sending a field nobody reads. Dropped knowingly.
  if (!Array.isArray(files) || !Array.isArray(sourceManifest)) {
    return { status: 400, body: { ok: false, error: 'files[] and sourceManifest[] are required' } }
  }
  try {
    const project = await readProject(name)
    if (!project) return { status: 404, body: { ok: false, error: 'Project not found' } }
    // One identity for this accept, used by the refusal record and by the
    // clear. Two derivations of "who is this" is how a row gets written under
    // one key and looked up under another.
    const acceptOwner = sourceConflictOwner(payload)
    // **The carrier normalizes; the caller does not have to.**
    //
    // `canonicalSnapshot` demands a manifest that is already normalized, unique
    // and SORTED, and rejects the whole push otherwise. The old route
    // normalized on the caller's behalf before handing it down, so no caller
    // has ever sorted one. Requiring it here would 400 every existing push with
    // an error about the manifest rather than about anything the author did --
    // and it would do so on the first write of every new project.
    const context = sourceManifestContext(project)
    const lifecycle = await sourceLifecycleStore(name, { context })
    const manifest = normalizeSourceManifest(sourceManifest, context)
    const previousRevision = (await lifecycle.readAuthority()).currentRevision || null
    // `bootstrap` and `submit` already ARE this accept, and they already carry
    // the refusal shape the source editor needs -- `deriveClassifications`, the
    // stored evidence, the clean-rebase acceptance and `markRefused`. An
    // `acceptFiles` written beside them was a second, worse implementation of
    // the thing this whole cut exists to stop having two of.
    const result = await runSerializedProjectSourceOperation(name, () =>
      acceptUnderOperationJournal(name, lifecycle, payload, async () => {
        const before = await lifecycle.readAuthority()
        // Callers know what CHANGED; the accept needs the whole project. Every
        // unnamed manifest path is carried forward by reference from the
        // current revision, which is what keeps an incremental push
        // incremental. Removal is still expressed by leaving the manifest.
        const complete = await lifecycle.carryForward(manifest, files)
        const input = { expectedRevision, files: complete, sourceManifest: manifest, dependencyPins }
        return before.state === SOURCE_AUTHORITY_UNINITIALIZED
          ? lifecycle.bootstrap(input)
          : lifecycle.submit(input)
      }, { crashAt }))
    // A crash boundary stops here deliberately: the revision may be durable but
    // the effects have not run, which is the state the next attempt has to
    // recover from. Returned rather than thrown, so a caller can tell a
    // simulated crash from a failure.
    if (result.simulatedCrash) {
      return { status: 599, body: { ok: false, simulatedCrash: true, crashedAt: result.crashedAt } }
    }
    // A replay is the SAME answer to the same request, not a second accept, so
    // it must not re-run the effects: mirroring and dispatching a build again
    // for a push that already landed is the retry storm this journal exists to
    // prevent, one layer up.
    if (result.replayed) {
      // **A replay must resume replicas that were recorded and never sent.**
      //
      // The effects record pending replica rows and then dispatch them. A
      // process dying between those two leaves a checkout owed a revision that
      // nothing will ever send it — and the retry cannot fix it by re-running,
      // because a replay deliberately returns before the effects.
      //
      // So the replay resumes rather than re-dispatches: `resumeOnly` tells the
      // handler to send what is still pending instead of treating this as a new
      // acceptance. Without it the only recovery is somebody noticing a
      // checkout is behind.
      const replayedRevision = result.operationResult?.sourceRevision ?? null

      // **A replay still owes the document.** The accept it is answering for
      // may have happened in a process that died before the effects ran, so the
      // revision is durable and the disk is empty. Returning the stored result
      // without this reports success over a paper that is not there.
      //
      // Only the working copy, deliberately: mirroring or dispatching a build
      // again is the retry storm the journal exists to prevent. This is
      // idempotent and no-ops when the disk is already at the revision.
      if (!result.invalidReuse && replayedRevision) {
        try {
          await materializeWorkingCopy(name, lifecycle, replayedRevision)
        } catch (error) {
          // Swallowed deliberately: this is a recovery attempt on an accept
          // that already happened, and the caller is owed the stored terminal
          // result. Throwing would turn a successful replay into a failure to
          // report that the catch-up failed -- and the next replay tries again,
          // because the ref still says the disk is behind.
          console.error(`[${name}] could not materialize on replay: ${error.message}`)
        }
      }

      if (!result.invalidReuse && replayedRevision && pendingSourceReplicaHandler) {
        void Promise.resolve().then(() => pendingSourceReplicaHandler({
          project: name,
          sourceRevision: replayedRevision,
          resumeOnly: true,
        })).catch(error => console.error(`[${name}] pending source replica replay failed: ${error.message}`))
      }
      return {
        status: result.invalidReuse ? 400 : (result.httpStatus || 200),
        body: { ...result, operationReplay: !result.invalidReuse, sourceOperationResult: result.operationResult ?? null },
      }
    }
    if (!result.ok) {
      // **Record the refusal, or the person stuck outside the paper leaves no
      // trace.** The 409 tells the pusher; without this, nobody else ever
      // learns — not the surface that shows who is held, not another
      // participant, not anyone looking later. Measured on a real paper on
      // 2026-08-13, on a bibliography nobody else had touched.
      //
      // The asymmetry is what made it invisible: the CLEAR side already moved
      // to the shared effects, so the new path erased the trace on accept and
      // never wrote it on refusal.
      // **Hand it the payload, do not enumerate.** `sourceConflictOwner` reads
      // `sourceMachineId` and `sourceEnvName` as well as the daemon key, and an
      // enumerated call drops whatever nobody remembered — silently, while
      // every grep for daemon identity still finds `sourceDaemonKey` and looks
      // healthy. The WS handler sends `sourceMachineId` today.
      //
      // It costs the ledger the thing it exists for: `sourceSyncRefusals`
      // answers *whose work is stuck and where is it*, and an owner with a
      // participant but no machine says somebody is stuck without saying which
      // machine to go and look at. For anyone working from two machines that is
      // the whole content of the row.
      const refusalOwner = acceptOwner
      const conflicted = conflictFilesFromLifecycleResult(result)
      try {
        if (conflicted.length > 0) {
          await recordSourceSyncConflicts(name, conflicted.map(file => ({
            file, owner: refusalOwner, source: 'source-authority',
          })))
        } else if (result.status === 'stale-base') {
          await recordSourceSyncRefusal(name, {
            owner: refusalOwner,
            reason: result.status,
            // **What he was CARRYING, not what he declared.** The carrier
            // requires every manifest path on every push, so `files` is
            // routinely the whole project — and a refusal row naming three
            // files when he edited one is not answerable, only alarming.
            //
            // The discriminator is already in the payload: an entry with
            // `content` is a change, an entry with only `sha256` is a carried
            // reference.
            files: (files || []).filter(file => file?.content !== undefined).map(file => file.path),
          })
        }
      } catch (error) {
        // Swallowed on purpose, and this is the reason rather than a habit: an
        // instrument must not be able to change the answer it is recording.
        // Throwing here would replace a 409 the caller can act on with a 500
        // they cannot, in order to report that the note-taking failed.
        console.error(`[${name}] could not record a refusal: ${error.message}`)
      }
      return {
        status: 409,
        body: {
          ok: false,
          status: result.status,
          currentRevision: result.authority?.currentRevision ?? result.revision ?? null,
          refusedRevision: result.refusedRevision ?? null,
          // **The merge, not just the rejection.** The source editor turns
          // `evidence.classifications[]` into conflict markers a person
          // resolves in place. Return the bare status and "resolve the markers
          // and it syncs" becomes "sync 409" on the surface Skip edits his
          // paper on -- a lost resolution path rather than a lost byte,
          // invisible in every log because the write correctly refused and the
          // caller correctly reported failure.
          evidence: result.evidence ?? null,
        },
      }
    }
    const sourceRevision = result.revision?.id ?? result.revision ?? null
    const acceptSeq = result.authority?.acceptSeq ?? null
    const metadata = {
      ...(session ? { session, sessionAt: sessionAt || Date.now() } : {}),
      ...(editedBy ? { lastEditedBy: editedBy, lastEditedByAt: Date.now() } : {}),
    }
    if (Object.keys(metadata).length) await updateProject(name, metadata)
    const ran = await applyAcceptedSourceEffects(name, lifecycle, {
      sourceRevision,
      acceptSeq,
      previousRevision: result.previous ?? previousRevision,
      editedBy,
      sourceBindingId,
      sourceDaemonKey,
      owner: acceptOwner,
      requestId: requestId || randomUUID(),
    })
    return {
      status: 200,
      body: {
        ok: true,
        // `already-current` is the same fact `unchanged` used to carry, so a
        // caller waiting on a build can stop waiting without a new field.
        status: result.status,
        unchanged: result.status === 'already-current',
        sourceRevision,
        acceptSeq,
        filesWritten: manifest.length,
        postAcceptEffects: ran,
        // The terminal result this request was journalled under. A caller that
        // retries gets this same object back, which is what makes a retry
        // answerable rather than re-runnable.
        sourceOperationResult: result.operationResult ?? null,
      },
    }
  } catch (error) {
    console.error(`[${name}] snapshot accept failed: ${error.message}`)
    return { status: 400, body: { ok: false, error: error.message } }
  }
}

/**
 * Upload one file's bytes and get back the id the snapshot can reference.
 *
 * The ceiling on a JSON snapshot is aggregate, because an atomic snapshot
 * cannot be split the way the old batched push could — and a bootstrap carries
 * nothing forward, so every byte is content. Raising the JSON parser's limit to
 * match the bundle route's 500mb is not symmetric with it: the bundle is
 * streamed to a file, while a JSON body of the same project is base64 held as a
 * string and then parsed into objects, several times its own size in memory,
 * per concurrent request.
 *
 * So the large case uploads blobs first, each request bounded, and then sends a
 * manifest of `{path, sha256}` references. That is the reference form
 * `carryForward` already emits and `canonicalSnapshot` already accepts, so
 * nothing about the accept changes.
 *
 * **An upload nobody references is an unreachable git object, collected by
 * `git gc` — which nothing on this path currently runs.** `hash-object -w`
 * writes a real object, so there is no store of ours accumulating and no
 * bespoke collection to write. But this store uses plumbing almost
 * exclusively, and plumbing does not trigger `gc --auto` the way porcelain
 * does; the one incidental trigger is `ingestBundle`'s `git fetch`, which is
 * the *other* carrier. So orphaned uploads are recoverable by a standard
 * mechanism that nothing here schedules. Written down rather than left
 * implicit: an admitted gap costs nothing and a silent one costs a night.
 */
router.post('/:name/source-blob', requireRw, express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ ok: false, error: 'a body is required' })
  }
  try {
    const lifecycle = await sourceLifecycleStore(req.params.name)
    res.json({ ok: true, ...(await lifecycle.putBlob(req.body)) })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

router.post('/:name/source-snapshot', requireRw, async (req, res) => {
  const { status, body } = await acceptSourceSnapshot(req.params.name, {
    ...(req.body || {}),
    editedBy: req.body?.editedBy || req.get('x-tlda-edited-by') || null,
  })
  res.status(status).json(body)
})

router.post('/:name/source-bundle', requireRw, express.raw({ type: () => true, limit: '500mb' }), async (req, res) => {
  const name = req.params.name
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ ok: false, error: 'a bundle body is required' })
  }
  const bundlePath = join(tmpdir(), `tlda-proposed-${process.pid}-${randomUUID()}.bundle`)
  try {
    await writeFile(bundlePath, req.body)
    const lifecycle = await sourceLifecycleStore(name)
    // Through the same journal as the JSON carrier, so the two cannot diverge
    // on idempotency. In practice the daemon sends no requestId and wants none:
    // it holds the change and RE-PROPOSES rather than retrying, which is a new
    // commit rather than the same one twice. A caller that does send one gets
    // the same dedup the other carrier gets.
    const result = await runSerializedProjectSourceOperation(name, () =>
      acceptUnderOperationJournal(name, lifecycle, { requestId: req.get('x-tlda-request-id') || null }, () =>
        lifecycle.acceptBundle(bundlePath)))
    if (result.replayed) {
      return res.status(result.invalidReuse ? 400 : (result.httpStatus || 200)).json(result)
    }
    if (!result.ok) {
      // A non-fast-forward is the proposer's to resolve, not ours to merge. They
      // hold the commits; they rebase and propose again.
      return res.status(409).json({
        ok: false,
        status: result.status,
        currentRevision: result.revision ?? null,
        refusedRevision: result.refusedRevision ?? null,
      })
    }
    const sourceRevision = result.revision?.id ?? result.revision ?? null
    const acceptSeq = result.authority?.acceptSeq ?? null
    const ran = await applyAcceptedSourceEffects(name, lifecycle, {
      sourceRevision,
      acceptSeq,
      previousRevision: result.previous ?? null,
      editedBy: req.get('x-tlda-edited-by') || null,
      sourceBindingId: req.get('x-tlda-source-binding') || null,
      // So the fan-out does not send this change back to the machine it came
      // from. A daemon that materializes its own push would overwrite the file
      // its author is still editing.
      sourceDaemonKey: req.get('x-tlda-source-daemon') || null,
      requestId: req.get('x-tlda-request-id') || randomUUID(),
    })
    res.json({
      ok: true,
      status: result.status,
      sourceRevision,
      acceptSeq,
      // Named rather than boolean, because "the accept worked" and "the work was
      // preserved" are different facts and the caller cannot see the second.
      postAcceptEffects: ran,
    })
  } catch (error) {
    console.error(`[${name}] proposed bundle failed: ${error.message}`)
    res.status(400).json({ ok: false, error: error.message })
  } finally {
    await rm(bundlePath, { force: true }).catch(() => {
      // Best effort on a temp file; the accept result is what the caller needs.
    })
  }
})

router.post('/:name/recording', requireRw, (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })
  const meta = req.body
  if (!meta?.id || !Array.isArray(meta.events)) {
    return res.status(400).json({ error: 'Recording needs id and events[]' })
  }
  const dir = recordingsDir(req.params.name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${meta.id}.json`), JSON.stringify(meta))
  res.json({ ok: true, id: meta.id })
})

// POST /:name/recording/:id/audio — store the raw audio blob (binary body)
router.post('/:name/recording/:id/audio', requireRw, express.raw({ type: () => true, limit: '500mb' }), (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })
  const dir = recordingsDir(req.params.name)
  const metaPath = join(dir, `${req.params.id}.json`)
  if (!existsSync(metaPath)) return res.status(404).json({ error: 'Record metadata first' })
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty audio body' })
  writeFileSync(join(dir, `${req.params.id}.audio`), req.body)
  res.json({ ok: true, id: req.params.id, bytes: req.body.length, state: 'private-draft' })
})

// Raw captures and their review state are private to the teaching token.
router.get('/:name/recording-drafts', requireRecordingPrivateRead, (req, res) => {
  const dir = recordingsDir(req.params.name)
  if (!existsSync(dir)) return res.json({ recordings: [] })
  const recordings = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const m = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        if (!existsSync(join(dir, `${m.id}.audio`))) return null
        const publication = readRecordingPublication(dir, m.id)
        if (publication?.state === 'published') return null
        return { id: m.id, title: m.title, created: m.created, duration_ms: m.duration_ms, publication }
      } catch (error) {
        // A recording that will not parse is NOT the same as no recording, and
        // this used to answer 200 {"recordings":[]} for both. Nothing is slow
        // and nothing throws outward, so no profiler and no guard can see it --
        // the only thing that finds it is a person noticing their lecture is
        // missing. Say so instead.
        console.error(`[recordings] unreadable recording metadata ${f}: ${error.message}`)
        return { id: f.replace(/\.json$/, ''), unreadable: true, error: error.message }
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))
  res.json({ recordings })
})

router.get('/:name/recording-draft/:id', requireRecordingPrivateRead, (req, res) => {
  const dir = recordingsDir(req.params.name)
  const metaPath = join(dir, `${req.params.id}.json`)
  if (!existsSync(metaPath)) return res.status(404).json({ error: 'Recording not found' })
  const recording = JSON.parse(readFileSync(metaPath, 'utf8'))
  res.json({ ...recording, publication: readRecordingPublication(dir, recording.id), privateDraft: true })
})

// Serve a recording's audio without reading it into memory.
//
// Both audio routes used to do `readFileSync(audioPath)` and `.send(buf)` with
// `Accept-Ranges: none`, against an upload limit of 500mb. That is a synchronous
// read of the whole file on the event loop: one student opening one lecture
// blocks every other request, every socket message and every daemon RPC for the
// length of that read. It is the same shape as the 809ms edit-log stall, on a
// bigger file.
//
// res.sendFile streams it and handles Range, ETag and Last-Modified — so seeking
// in a lecture fetches the bytes around the seek instead of the whole recording,
// which is also what `Accept-Ranges: none` was denying. Using express's own
// implementation rather than hand-rolling range parsing, because that is a
// solved problem with edge cases (suffix ranges, unsatisfiable ranges, HEAD)
// that a hand-rolled version gets wrong quietly.
export function sendRecordingAudio(res, audioPath, metaPath) {
  let mime = 'audio/webm'
  if (existsSync(metaPath)) {
    try {
      mime = (JSON.parse(readFileSync(metaPath, 'utf8')).audioMime || mime).split(';')[0]
    } catch { /* a corrupt meta file must not make the audio unplayable */ }
  }
  res.type(mime)
  return res.sendFile(audioPath, { acceptRanges: true, dotfiles: 'deny' }, (error) => {
    if (!error || res.headersSent) return
    // Carry sendFile's OWN status. A first version of this returned 500 for
    // everything, which turned a client asking for a range past the end of the
    // file -- an ordinary, correct thing for a player to do while seeking --
    // into a server error. Caught only once the test stopped exercising a copy
    // of this handler and imported the real one.
    const status = error.status || error.statusCode || 500
    if (status === 416) return res.status(416).end()
    res.status(status).json({ error: `Audio read failed: ${error.message}` })
  })
}

router.get('/:name/recording-draft/:id/audio', requireRecordingPrivateRead, (req, res) => {
  const dir = recordingsDir(req.params.name)
  const audioPath = join(dir, `${req.params.id}.audio`)
  const metaPath = join(dir, `${req.params.id}.json`)
  if (!existsSync(audioPath) || !existsSync(metaPath)) return res.status(404).json({ error: 'Audio not found' })
  return sendRecordingAudio(res, audioPath, metaPath)
})

router.put('/:name/recording/:id/owner-interval', requireRw, (req, res) => {
  const dir = recordingsDir(req.params.name)
  const metaPath = join(dir, `${req.params.id}.json`)
  if (!existsSync(metaPath)) return res.status(404).json({ error: 'Recording not found' })
  try {
    res.json(writeOwnerInterval(dir, JSON.parse(readFileSync(metaPath, 'utf8')), req.body, 'classroom:rw'))
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return res.status(400).json({ error: error.message })
    return res.status(409).json({ error: error.message })
  }
})

router.post('/:name/recording/:id/publish', requireRw, async (req, res) => {
  const dir = recordingsDir(req.params.name)
  const metaPath = join(dir, `${req.params.id}.json`)
  if (!existsSync(metaPath)) return res.status(404).json({ error: 'Recording not found' })
  const recording = JSON.parse(readFileSync(metaPath, 'utf8'))
  const candidate = readRecordingPublication(dir, recording.id)
  if (candidate?.state !== 'candidate-clip') return res.status(409).json({ error: 'Review and save the class interval before publication' })
  try {
    await materializeRecordingAudioClip(dir, recording.id, candidate)
    res.json(writePublishedRecording(dir, recording, 'classroom:rw'))
  } catch (error) {
    return res.status(500).json({ error: `Recording publication failed: ${error.message}` })
  }
})

// GET /:name/recordings — list recordings (newest first)
router.get('/:name/recordings', requireRead, (req, res) => {
  const dir = recordingsDir(req.params.name)
  if (!existsSync(dir)) return res.json({ recordings: [] })
  const recordings = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const m = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        if (readRecordingPublication(dir, m.id)?.state !== 'published') return null
        return { id: m.id, title: m.title, created: m.created, duration_ms: m.duration_ms }
      } catch (error) {
        // Same as the drafts listing above: unreadable is not absent.
        console.error(`[recordings] unreadable recording metadata ${f}: ${error.message}`)
        return { id: f.replace(/\.json$/, ''), unreadable: true, error: error.message }
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))
  res.json({ recordings })
})

// GET /:name/recording/:id — full metadata + events
router.get('/:name/recording/:id', requireRead, (req, res) => {
  const dir = recordingsDir(req.params.name)
  const metaPath = join(recordingsDir(req.params.name), `${req.params.id}.json`)
  if (!existsSync(metaPath)) return res.status(404).json({ error: 'Recording not found' })
  const publication = readRecordingPublication(dir, req.params.id)
  if (publication?.state !== 'published') return res.status(404).json({ error: 'Recording not found' })
  const recording = JSON.parse(readFileSync(metaPath, 'utf8'))
  res.json(clipRecordingData(recording, publication))
})

// GET /:name/recording/:id/audio — stream the audio blob
router.get('/:name/recording/:id/audio', requireRead, (req, res) => {
  const dir = recordingsDir(req.params.name)
  const publication = readRecordingPublication(dir, req.params.id)
  if (publication?.state !== 'published') return res.status(404).json({ error: 'Audio not found' })
  const audioPath = join(dir, 'publication', `${req.params.id}.audio`)
  const metaPath = join(dir, `${req.params.id}.json`)
  if (!existsSync(audioPath)) return res.status(404).json({ error: 'Audio not found' })
  return sendRecordingAudio(res, audioPath, metaPath)
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

  const { text, startLine, color = 'orange', file, createdBy, fleet_id, friendly_name } = req.body
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
        ...(createdBy ? { createdBy } : {}),
        ...(fleet_id ? { fleet_id } : {}),
        ...(friendly_name ? { friendly_name } : {}),
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
