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
import { projectRevisionStatus } from '../lib/source-lifecycle.mjs'
import { emitSourceEditEvent } from '../lib/source-edit-event.mjs'
import { outlineForRegion, regionFromSpan, structuralLeaves } from '../lib/outline/outline.mjs'
import { buildModel, assertRoundTrip } from '../lib/outline/model.mjs'
import { findTextNearSourceLine, sourceTextSpanToPdfSpans } from '../lib/synctex-query.mjs'
import { compareHighlightFeedbackBySource, highlightFeedbackFromShape } from '../lib/highlight-feedback.mjs'
import { realizeProjectMarkdownArtifact, writeProjectMarkdownArtifact } from '../lib/project-artifact-materializer.mjs'
import { TASK_DOC_FILENAME, TASK_DOC_PROJECT_ID, STATUS_TASK_DOC_ROW_LIMIT, materializeTaskDocs } from '../lib/task-doc-materializer.mjs'
import { markdownColumnFileForSource, listProjectPartColumns, pageInfoFromDocumentColumns } from '../lib/document-columns.mjs'
import { clipRecordingData, readRecordingPublication, writeOwnerInterval, writePublishedRecording } from '../lib/recording-publication.mjs'
import { materializeRecordingAudioClip } from '../lib/recording-audio-clip.mjs'
import { isManagedSourcePath, normalizeSourceManifest, referencedRootsFromPaths, sourceManifestContext } from '../../shared/source-manifest.mjs'
import historyRoutes from './history.mjs'
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
    emitGlobalEvent('project-changed', { name: req.params.name })
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

// Delete project
router.delete('/:name', requireRw, async (req, res) => {
  try {
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

router.post('/:name/source-room/files', requireRw, async (req, res) => {
  const daemon = req.app?.locals?.sourceRoomDaemon
  if (!daemon?.submitFiles) return res.status(503).json({ ok: false, error: 'source-room Git submission is not configured' })
  try {
    const result = await daemon.submitFiles(req.params.name, req.body || {})
    res.status(result.status).json(result.body)
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

router.get('/:name/source-head', requireRead, async (req, res) => {
  try {
    const git = await (await sourceLifecycleStore(req.params.name)).gitRepository()
    res.json({ revision: await git.head(req.params.name) })
  } catch (error) {
    res.status(404).json({ error: error.message })
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
