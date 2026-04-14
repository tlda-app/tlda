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
 *   POST   /:name/push          Push files + trigger build
 *   POST   /:name/build         Trigger rebuild
 *   GET    /:name/build/status  Build status + log
 */

import { Router } from 'express'
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { requireRead, requireRw } from '../lib/auth.mjs'
import {
  createProject, readProject, updateProject, listProjects, deleteProject,
  listSourceFiles, hashSourceFiles, readSourceFile, writeSourceFile, deleteSourceFile, readBuildLog, sourceDir as getSourceDir, outputDir as getOutputDir,
  extractBuildErrors, extractPipelineWarnings, addBookMember, getProjectsDir,
} from '../lib/project-store.mjs'
import { runBuild, getBuildStatus } from '../lib/build-runner.mjs'
import { buildMarkdown, buildHtml, buildSlides } from '../lib/format-builders.mjs'
import historyRoutes from './history.mjs'
import { getRoomRecords, getRecord, putShape, updateShape, deleteShape, onShapeChange, getOrCreateRoom, broadcastSignal, getLastSignal, onSignal, replaceRoomSnapshot, getShapesAt, emitGlobalEvent, onGlobalEvent } from '../lib/sync-rooms.mjs'

const router = Router()

// Mount history sub-router
router.use('/:name/history', historyRoutes)

// List all projects
router.get('/', requireRead, (req, res) => {
  res.json({ projects: listProjects() })
})

// Project timestamps — computed from disk, not stored in manifest
router.get('/meta', requireRead, (req, res) => {
  const meta = {}
  const dir = getProjectsDir()
  for (const project of listProjects()) {
    const name = project.name
    let lastAnnotated = null
    const snapPath = join(dir, name, 'sync-snapshot.json')
    if (existsSync(snapPath)) {
      try { lastAnnotated = statSync(snapPath).mtime.toISOString() } catch {}
    }
    meta[name] = {
      ...(project.lastBuild && { lastBuild: project.lastBuild }),
      ...(lastAnnotated && { lastAnnotated }),
    }
  }
  res.json(meta)
})

// GET /health — check sync health for all docs that have a snapshot
router.get('/health', requireRead, (req, res) => {
  const health = {}
  const dir = getProjectsDir()
  for (const project of listProjects()) {
    const snapPath = join(dir, project.name, 'sync-snapshot.json')
    if (!existsSync(snapPath)) continue
    try {
      const room = getOrCreateRoom(syncRoomName(project.name))
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
router.get('/events/stream', requireRead, (req, res) => {
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
router.get('/archived', requireRead, (req, res) => {
  const projects = listProjects().filter(p => p.archived)
  res.json({ projects })
})

// Create project
router.post('/', requireRw, (req, res) => {
  try {
    const { name, title, mainFile, sourceDir, format, members } = req.body
    if (!name) return res.status(400).json({ error: 'name is required' })
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return res.status(400).json({ error: 'name must be lowercase alphanumeric with hyphens' })
    }
    if (format === 'book' && (!members || !Array.isArray(members) || members.length === 0)) {
      return res.status(400).json({ error: 'book format requires a non-empty members array' })
    }
    const project = createProject({ name, title, mainFile, sourceDir, format, members })
    // Notify fleet-daemons so they can start watching the new sourceDir.
    if (project.sourceDir) emitGlobalEvent('project-changed', { name: project.name })
    res.status(201).json(project)
  } catch (e) {
    res.status(409).json({ error: e.message })
  }
})

// Get project
router.get('/:name', requireRead, (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const activeBuild = getBuildStatus(req.params.name)
  res.json({
    ...project,
    ...(activeBuild?.building && { activeBuild }),
  })
})

// Archive/unarchive project
router.patch('/:name/archive', requireRw, (req, res) => {
  try {
    const { archived } = req.body
    const project = updateProject(req.params.name, { archived: !!archived })
    res.json({ ok: true, archived: project.archived })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

// Delete project
router.delete('/:name', requireRw, (req, res) => {
  try {
    deleteProject(req.params.name)
    res.json({ ok: true })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

// Add member to book (create book project if needed)
router.patch('/:name/members', requireRw, (req, res) => {
  const { add } = req.body
  if (!add || typeof add !== 'string') return res.status(400).json({ error: 'add member name required' })
  try {
    const book = addBookMember(req.params.name, add)
    res.json({ ok: true, members: book.members })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// List source files
router.get('/:name/files', requireRead, (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  res.json({ files: listSourceFiles(req.params.name) })
})

// Read a specific source file's content
router.get('/:name/source/:file', requireRead, (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  try {
    const content = readSourceFile(req.params.name, req.params.file)
    if (content === null) return res.status(404).json({ error: 'File not found' })
    res.set('Content-Type', 'text/plain; charset=utf-8').send(content)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Preamble macros (KaTeX-compatible, parsed during build from main tex file)
router.get('/:name/macros', requireRead, (req, res) => {
  const outputPath = join(getOutputDir(req.params.name), 'macros.json')
  if (!existsSync(outputPath)) return res.json({ macros: {} })
  try {
    const data = JSON.parse(readFileSync(outputPath, 'utf8'))
    res.json({ macros: data.macros || {} })
  } catch {
    res.json({ macros: {} })
  }
})

// Source file hashes (for incremental push)
router.get('/:name/hashes', requireRead, (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  res.json({ hashes: hashSourceFiles(req.params.name) })
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
export async function processProjectPush(name, body) {
  const project = readProject(name)
  if (!project) return { status: 404, ok: false, error: 'Project not found' }

  const { files, deletedFiles, priorityPages, sourceDir, members, session, sessionAt } = body || {}

  if (sourceDir && !project.sourceDir) updateProject(name, { sourceDir })
  if (session) updateProject(name, { session, sessionAt: sessionAt || Date.now() })

  if (members && Array.isArray(members)) {
    updateProject(name, { members })
    if (project.format === 'book') return { status: 200, ok: true, members }
  }

  let anyChanged = false
  if (files?.length > 0) {
    for (const file of files) {
      const content = file.encoding === 'base64'
        ? Buffer.from(file.content, 'base64')
        : file.content
      if (writeSourceFile(name, file.path, content)) anyChanged = true
    }
  }
  if (deletedFiles?.length > 0) {
    for (const filePath of deletedFiles) {
      if (deleteSourceFile(name, filePath)) anyChanged = true
    }
  }

  if (!anyChanged && project.buildStatus === 'success') {
    return { status: 200, ok: true, filesWritten: 0, building: false, unchanged: true }
  }

  // New files written — if the viewer was pinned to an old version, unpin it now.
  broadcastSignal(`doc-${name}`, 'signal:view-pin', { ref: null, timestamp: Date.now() })

  // LaTeX/SVG format: filter out source-change events for files that
  // aren't part of the main file's include tree. The tree is captured
  // from pdflatex's .fls after each successful build and stored as
  // relevant-files.json in the project output dir. Files outside the
  // tree (e.g. scratch notes under the project dir) still get mirrored
  // above, but we skip the rebuild. If the set file doesn't exist yet,
  // no rebuild either — bootstrap the set with a manual `tlda build`.
  if (project.format === 'svg' && files?.length > 0) {
    const relevantPath = join(getOutputDir(name), 'relevant-files.json')
    if (!existsSync(relevantPath)) {
      console.log(`[${name}] push skipped: relevant-files.json missing — run \`tlda build ${name}\` to bootstrap`)
      return { status: 200, ok: true, filesWritten: files.length, building: false, filtered: true, reason: 'no-relevant-set' }
    }
    try {
      const { files: relevantList } = JSON.parse(readFileSync(relevantPath, 'utf8'))
      const relevantSet = new Set(relevantList || [])
      const authorDir = project.sourceDir
      const mirrorDir = getSourceDir(name)
      const anyRelevant = files.some(f => {
        const mirrorPath = join(mirrorDir, f.path)
        if (relevantSet.has(mirrorPath)) return true
        if (authorDir && relevantSet.has(join(authorDir, f.path))) return true
        return false
      })
      if (!anyRelevant) {
        return { status: 200, ok: true, filesWritten: files.length, building: false, filtered: true, reason: 'outside-tree' }
      }
    } catch (e) {
      console.error(`[${name}] relevant-files.json parse failed: ${e.message}`)
      return { status: 200, ok: true, filesWritten: files.length, building: false, filtered: true, reason: 'parse-failed' }
    }
  }

  // Non-SVG formats: kick off build async, return immediately.
  if (project.format === 'markdown' || project.format === 'html' || project.format === 'slides') {
    const builder = { markdown: buildMarkdown, html: buildHtml, slides: buildSlides }[project.format]
    builder(name).then(() => {
      const updated = readProject(name)
      if (updated?.buildStatus === 'success') {
        emitGlobalEvent('doc-arrived', {
          name, title: updated.title || name,
          format: updated.format, pages: updated.pages || 0,
        })
      }
    }).catch(e => {
      console.error(`[${project.format}] Build failed for ${name}: ${e.message}`)
      updateProject(name, { buildStatus: 'error' })
    })
    return { status: 200, ok: true, filesWritten: files?.length || 0, building: true }
  }

  // SVG/LaTeX format: debounced build. runBuild kills any in-progress
  // build and restarts — that was fine for single pushes but with a
  // rapid-fire editor (math agent typing) each push killed the running
  // build, so nothing ever completed. Debounce here so rapid edits
  // coalesce into a single build that starts after the edits pause.
  scheduleDebouncedBuild(name, priorityPages)
  return { status: 200, ok: true, filesWritten: files?.length || 0, building: true }
}

// Per-project debounce for runBuild. Key = project name, value = timer id.
// On each push we clear any pending timer and schedule a fresh one. The
// build only fires after `BUILD_DEBOUNCE_MS` of quiet. Combined with
// runBuild's existing "kill in-progress and restart" behavior, this
// means: the LAST edit in a burst wins, and rapid bursts don't cause
// thrashing.
const _buildDebounceTimers = new Map()
const BUILD_DEBOUNCE_MS = 1500

function scheduleDebouncedBuild(name, priorityPages) {
  const existing = _buildDebounceTimers.get(name)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(async () => {
    _buildDebounceTimers.delete(name)
    try {
      await runBuild(name, { priorityPages })
      const updated = readProject(name)
      if (updated?.buildStatus === 'success') {
        emitGlobalEvent('doc-arrived', {
          name, title: updated.title || name,
          format: updated.format, pages: updated.pages || 0,
        })
      }
    } catch (e) {
      console.error(`[api] Build failed for ${name}: ${e.message}`)
    }
  }, BUILD_DEBOUNCE_MS)
  _buildDebounceTimers.set(name, timer)
}

// Push files + trigger build
router.post('/:name/push', requireRw, async (req, res) => {
  const result = await processProjectPush(req.params.name, req.body)
  const { status, ...payload } = result
  res.status(status).json(payload)
})

// Trigger rebuild (no file changes)
router.post('/:name/build', requireRw, async (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const { priorityPages } = req.body || {}

  res.json({ ok: true, building: true })

  try {
    const builder = { markdown: buildMarkdown, html: buildHtml, slides: buildSlides }[project.format]
    if (builder) {
      await builder(req.params.name)
    } else {
      await runBuild(req.params.name, { priorityPages })
    }
  } catch (e) {
    console.error(`[api] Build failed for ${req.params.name}: ${e.message}`)
  }
})

// Build status + log
router.get('/:name/build/status', requireRead, (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const activeBuild = getBuildStatus(req.params.name)
  const buildLog = readBuildLog(req.params.name)

  res.json({
    status: activeBuild?.building ? 'building' : project.buildStatus,
    phase: activeBuild?.phase || null,
    lastBuild: project.lastBuild,
    log: buildLog,
  })
})

// LaTeX errors from the build log
router.get('/:name/build/errors', requireRead, (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const activeBuild = getBuildStatus(req.params.name)
  const building = activeBuild?.building || false

  const { errors, warnings } = extractBuildErrors(req.params.name)
  const pipelineWarnings = extractPipelineWarnings(req.params.name)

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
router.get('/:name/shapes', requireRead, (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })
  const records = getRoomRecords(syncRoomName(req.params.name), req.query.type || null)
  res.json(records)
})

// GET /:name/shapes/at/:timestamp — reconstruct shapes at a point in time
router.get('/:name/shapes/at/:timestamp', requireRead, (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })
  const ts = parseInt(req.params.timestamp, 10)
  if (isNaN(ts) || ts <= 0) return res.status(400).json({ error: 'Invalid timestamp (unix ms)' })
  const result = getShapesAt(req.params.name, ts)
  res.json(result)
})

// POST /:name/shapes — create a shape
router.post('/:name/shapes', requireRw, async (req, res) => {
  const project = readProject(req.params.name)
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
  const project = readProject(req.params.name)
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
  const project = readProject(req.params.name)
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
router.post('/:name/snapshot', requireRw, (req, res) => {
  const project = readProject(req.params.name)
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
router.post('/:name/sync/clear', requireRw, (req, res) => {
  const project = readProject(req.params.name)
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
router.get('/:name/sync/health', requireRead, (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })
  try {
    const room = getOrCreateRoom(syncRoomName(req.params.name))
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
router.get('/:name/signal/stream', requireRead, (req, res) => {
  const project = readProject(req.params.name)
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
router.get('/:name/signal/:key', requireRead, (req, res) => {
  const signal = getLastSignal(syncRoomName(req.params.name), req.params.key)
  if (!signal) return res.status(404).json({ error: 'No cached signal' })
  res.json(signal)
})

// GET /:name/highlight-feedback — structured feedback from highlight shapes
// Maps highlight colors to semantic types (approve/reject/question/expand/comment/info)
const HIGHLIGHT_THEMES = {
  'light-green': { type: 'approve', label: 'Good, keep this' },
  'green':       { type: 'approve', label: 'Good, keep this' },
  'light-red':   { type: 'reject', label: 'Fix this' },
  'red':         { type: 'reject', label: 'Fix this' },
  'yellow':      { type: 'question', label: 'Question / unsure' },
  'light-violet': { type: 'expand', label: 'Develop further' },
  'violet':      { type: 'expand', label: 'Develop further' },
  'orange':      { type: 'comment', label: 'General comment' },
  'light-blue':  { type: 'info', label: 'Note / reference' },
  'blue':        { type: 'info', label: 'Note / reference' },
}
router.get('/:name/highlight-feedback', requireRead, (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })

  const records = getRoomRecords(syncRoomName(req.params.name), 'highlight')
  const feedback = records
    .filter(shape => shape.meta?.highlightText)
    .map(shape => {
      const color = shape.props?.color || 'yellow'
      const theme = HIGHLIGHT_THEMES[color] || { type: 'comment', label: 'General comment' }
      return {
        type: theme.type,
        label: theme.label,
        color,
        shapeId: shape.id,
        text: shape.meta.highlightText || '',
        highlightLines: shape.meta.highlightLines || [],
        sourceLine: shape.meta.sourceLine ?? null,
        addressed: shape.meta.addressed === true,
        createdAt: shape.meta.createdAt ?? null,
        opacity: shape.opacity ?? 1,
      }
    })
    .sort((a, b) => (a.sourceLine || 0) - (b.sourceLine || 0))

  res.json({ doc: req.params.name, feedback })
})

// GET /:name/shapes/stream — SSE stream of shape changes (must be before :id route)
router.get('/:name/shapes/stream', requireRead, (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })
  res.write('data: {"type":"connected"}\n\n')

  // SSE keepalive to prevent proxy (Fly) from killing idle connections
  const keepalive = setInterval(() => res.write(':\n\n'), 15000)

  // Ensure room exists so we get change notifications
  getOrCreateRoom(syncRoomName(req.params.name))

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
router.get('/:name/shapes/:id', requireRead, (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Not found' })
  const shapeId = req.params.id.startsWith('shape:') ? req.params.id : `shape:${req.params.id}`
  const record = getRecord(syncRoomName(req.params.name), shapeId)
  if (!record) return res.status(404).json({ error: 'Shape not found' })
  res.json(record)
})

export default router
