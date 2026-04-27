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
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { join, basename } from 'path'
import { requireRead, requireRw } from '../lib/auth.mjs'
import {
  createProject, readProject, updateProject, listProjects, deleteProject,
  listSourceFiles, hashSourceFiles, readSourceFile, writeSourceFile, deleteSourceFile, readBuildLog, sourceDir as getSourceDir, outputDir as getOutputDir,
  extractBuildErrors, extractPipelineWarnings, addBookMember, getProjectsDir, projectDir as getProjectDir,
} from '../lib/project-store.mjs'
import { runBuild, getBuildStatus } from '../lib/build-runner.mjs'
import { loadSynctex } from '../lib/synctex-query.mjs'
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

// Toggle autoSync (git mirror sync)
router.patch('/:name/auto-sync', requireRw, (req, res) => {
  try {
    const { autoSync } = req.body
    const project = updateProject(req.params.name, { autoSync: !!autoSync })
    res.json({ ok: true, autoSync: project.autoSync })
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

// Synctex path-based lookup: trace highlight path through synctex records
router.post('/:name/synctex-path', requireRead, async (req, res) => {
  const { getSourceFromPath } = await import('../lib/synctex-query.mjs')
  const { page, points, text } = req.body
  if (!page || !points?.length) {
    return res.status(400).json({ error: 'Required: page, points[]' })
  }
  try {
    const result = await getSourceFromPath(req.params.name, page, points, text || '')
    if (!result) return res.status(404).json({ error: 'No synctex data or no match' })
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
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
      // No relevant-files.json yet — mark stale so the initial page request triggers a build.
      markProjectStale(name)
      broadcastSignal(`doc-${name}`, 'signal:source-changed', { timestamp: Date.now() })
      return { status: 200, ok: true, filesWritten: files.length, building: false }
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

  // SVG/LaTeX format: mark source as stale so ensureCurrentDvi rebuilds on
  // the next page request. No proactive build — Ensure does everything.
  markProjectStale(name)
  broadcastSignal(`doc-${name}`, 'signal:source-changed', { timestamp: Date.now() })
  return { status: 200, ok: true, filesWritten: files?.length || 0, building: false }
}

/**
 * Mark a project's source as stale. Writes a source.stamp file whose mtime is
 * checked by ensureCurrentDvi — if source.stamp is newer than main.dvi, the
 * next page request triggers a full LaTeX rebuild.
 */
function markProjectStale(name) {
  const dir = getProjectDir(name)
  try {
    writeFileSync(join(dir, 'source.stamp'), new Date().toISOString())
  } catch (e) {
    console.error(`[${name}] Failed to write source.stamp: ${e.message}`)
  }
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
  const clean = req.query.clean === '1'

  // Clean build: delete aux/biber cache files before rebuilding
  if (clean) {
    const srcDir = getSourceDir(req.params.name)
    if (existsSync(srcDir)) {
      const cleanExts = ['.aux', '.bbl', '.bcf', '.blg', '.run.xml', '.fls', '.fdb_latexmk', '.synctex.gz', '.log', '.out', '.toc', '.lof', '.lot']
      for (const file of readdirSync(srcDir)) {
        if (cleanExts.some(ext => file.endsWith(ext))) {
          try { const { unlinkSync } = await import('fs'); unlinkSync(join(srcDir, file)) } catch {}
        }
      }
      console.log(`[api] Clean build: deleted aux files for ${req.params.name}`)
    }
  }

  res.json({ ok: true, building: true, clean })

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

// --- Coordinate constants (shared/layout-constants.json) ---
const _lc = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'shared', 'layout-constants.json'), 'utf8'))
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

/** Strip tex commands to get approximate rendered text. */
function stripTex(tex) {
  return tex
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}$^_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
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

// POST /:name/highlight — text-based highlight using synctex data
router.post('/:name/highlight', requireRead, async (req, res) => {
  const name = req.params.name
  const project = readProject(name)
  if (!project) return res.status(404).json({ error: 'Not found' })

  const { text, startLine, color = 'orange', file } = req.body
  if (!text || startLine == null) {
    return res.status(400).json({ error: 'Missing required parameters: text, startLine' })
  }

  try {
    // 1. Read the source file
    const mainFile = file || project.mainFile || project.main
    if (!mainFile) return res.status(400).json({ error: 'No main file configured for project' })
    const sourceContent = readSourceFile(name, mainFile)
    if (!sourceContent) return res.status(404).json({ error: `Source file not found: ${mainFile}` })

    const sourceLines = sourceContent.split('\n')

    // 2. Search for text near startLine (±10 lines)
    const searchStart = Math.max(0, startLine - 11) // 0-indexed
    const searchEnd = Math.min(sourceLines.length, startLine + 10)
    const searchRegion = sourceLines.slice(searchStart, searchEnd).join('\n')

    const matchIdx = searchRegion.indexOf(text)
    if (matchIdx === -1) {
      return res.status(404).json({ error: `Text "${text.slice(0, 50)}..." not found near line ${startLine}` })
    }

    // Convert matchIdx back to line number and column
    const beforeMatch = searchRegion.slice(0, matchIdx)
    const matchStartLine = searchStart + beforeMatch.split('\n').length // 1-indexed
    const matchStartCol = beforeMatch.split('\n').pop().length // 0-indexed column

    const matchEndOffset = matchIdx + text.length
    const beforeEnd = searchRegion.slice(0, matchEndOffset)
    const matchEndLine = searchStart + beforeEnd.split('\n').length // 1-indexed
    const matchEndCol = beforeEnd.split('\n').pop().length

    // 3. Load synctex data for precise x-positions
    const synctex = await loadSynctex(name)
    if (!synctex) {
      return res.status(500).json({ error: 'Synctex data not available (build may be needed)' })
    }

    // Filter to source .tex files
    const sourceFileIds = new Set()
    for (const [id, filePath] of synctex.inputMap) {
      if (filePath.endsWith('.tex')) sourceFileIds.add(id)
    }

    // Find the target input file ID (match by basename)
    const targetBasename = basename(mainFile)
    let targetFileId = null
    for (const [id, filePath] of synctex.inputMap) {
      if (basename(filePath) === targetBasename) { targetFileId = id; break }
    }

    // Get synctex records for matched lines, grouped by line
    const recordsByLine = new Map()
    for (const r of synctex.records) {
      if (r.line < matchStartLine || r.line > matchEndLine) continue
      if (targetFileId != null && r.inputId !== targetFileId) continue
      if (!sourceFileIds.has(r.inputId)) continue
      if (!recordsByLine.has(r.line)) recordsByLine.set(r.line, [])
      recordsByLine.get(r.line).push(r)
    }

    if (recordsByLine.size === 0) {
      return res.status(404).json({ error: `No synctex records found for lines ${matchStartLine}–${matchEndLine}` })
    }

    // Determine page from first record
    const firstLineRecs = recordsByLine.values().next().value
    const page = firstLineRecs[0].page

    // 4. For each matched line, use x-records to find precise PDF x-range
    const segments = []
    let hlLeft = Infinity, hlRight = -Infinity
    let hlTop = Infinity, hlBottom = -Infinity

    // Group ALL synctex records for the matched lines by rendered line (y-position),
    // since a single source line can wrap across multiple rendered PDF lines.
    const renderedLines = new Map() // y → { records: [], srcLine, colStart, colEnd }
    for (let ln = matchStartLine; ln <= matchEndLine; ln++) {
      const lineRecs = recordsByLine.get(ln)
      if (!lineRecs || lineRecs.length === 0) continue

      const srcLine = sourceLines[ln - 1] || ''
      let colStart = 0, colEnd = srcLine.length
      if (ln === matchStartLine) colStart = matchStartCol
      if (ln === matchEndLine) colEnd = matchEndCol

      // Group records by y (rendered line) — records with same y are on the same rendered line
      for (const r of lineRecs) {
        const yKey = Math.round(r.y) // round to avoid float precision issues
        if (!renderedLines.has(yKey)) {
          renderedLines.set(yKey, { y: r.y, records: [], srcLine, ln, colStart, colEnd })
        }
        renderedLines.get(yKey).records.push(r)
      }
    }

    // For each source line in the match, find the synctex records that
    // correspond to the matched text and use their x-positions directly.
    // Records are in source order — we pick the ones at index positions
    // matching the start and end of the target text.
    for (let ln = matchStartLine; ln <= matchEndLine; ln++) {
      const lineRecs = recordsByLine.get(ln)
      if (!lineRecs || lineRecs.length === 0) continue

      // All records for this source line, in source order (y asc, x asc)
      const allInOrder = [...lineRecs].sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x)
      const N = allInOrder.length
      if (N === 0) continue

      const srcLine = sourceLines[ln - 1] || ''
      const strippedLine = stripTex(srcLine)
      const strippedLen = strippedLine.length || 1

      let colStart = 0, colEnd = srcLine.length
      if (ln === matchStartLine) colStart = matchStartCol
      if (ln === matchEndLine) colEnd = matchEndCol

      const strippedPre = stripTex(srcLine.slice(0, colStart)).length
      const strippedMatch = stripTex(srcLine.slice(colStart, colEnd)).length
      if (strippedMatch === 0) continue

      // Find the record at the start and end of the matched text
      const startRecIdx = Math.max(0, Math.round((strippedPre / strippedLen) * (N - 1)))
      const endRecIdx = Math.min(N - 1, Math.round(((strippedPre + strippedMatch) / strippedLen) * (N - 1)))

      const startRec = allInOrder[startRecIdx]
      const endRec = allInOrder[endRecIdx]

      // Group by rendered line (y) — if start and end are on different rendered lines, create segments for each
      const yValues = new Set(allInOrder.slice(startRecIdx, endRecIdx + 1).map(r => Math.round(r.y)))

      for (const yKey of yValues) {
        const recsOnLine = allInOrder.slice(startRecIdx, endRecIdx + 1).filter(r => Math.round(r.y) === yKey)
        if (recsOnLine.length === 0) continue
        const xStart = Math.min(...recsOnLine.map(r => r.x))
        const xEnd = Math.max(...recsOnLine.map(r => r.x))
        const matchY = recsOnLine[0].y

        const canvasStart = pdfToCanvasLocal(page, xStart, matchY)
        const canvasEnd = pdfToCanvasLocal(page, xEnd, matchY)

        hlLeft = Math.min(hlLeft, canvasStart.x)
        hlRight = Math.max(hlRight, canvasEnd.x)
        hlTop = Math.min(hlTop, canvasStart.y - 3)
        hlBottom = Math.max(hlBottom, canvasStart.y + 3)
      }
    }

    if (hlLeft === Infinity) {
      return res.status(404).json({ error: `Could not compute highlight position for lines ${matchStartLine}–${matchEndLine}` })
    }

    // 5. Build highlight segments using same record-based approach
    for (let ln = matchStartLine; ln <= matchEndLine; ln++) {
      const lineRecs = recordsByLine.get(ln)
      if (!lineRecs || lineRecs.length === 0) continue

      const allInOrder = [...lineRecs].sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x)
      const N = allInOrder.length
      const srcLine = sourceLines[ln - 1] || ''
      const strippedLen = stripTex(srcLine).length || 1

      let colStart = 0, colEnd = srcLine.length
      if (ln === matchStartLine) colStart = matchStartCol
      if (ln === matchEndLine) colEnd = matchEndCol

      const strippedPre = stripTex(srcLine.slice(0, colStart)).length
      const strippedMatch = stripTex(srcLine.slice(colStart, colEnd)).length
      if (strippedMatch === 0) continue

      const startRecIdx = Math.max(0, Math.round((strippedPre / strippedLen) * (N - 1)))
      const endRecIdx = Math.min(N - 1, Math.round(((strippedPre + strippedMatch) / strippedLen) * (N - 1)))

      const yValues = new Set(allInOrder.slice(startRecIdx, endRecIdx + 1).map(r => Math.round(r.y)))
      for (const yKey of yValues) {
        const recsOnLine = allInOrder.slice(startRecIdx, endRecIdx + 1).filter(r => Math.round(r.y) === yKey)
        if (recsOnLine.length === 0) continue
        const xStart = Math.min(...recsOnLine.map(r => r.x))
        const xEnd = Math.max(...recsOnLine.map(r => r.x))
        const matchY = recsOnLine[0].y

        const canvasStart = pdfToCanvasLocal(page, xStart, matchY)
        const canvasEnd = pdfToCanvasLocal(page, xEnd, matchY)
        const segLeft = canvasStart.x - hlLeft
        const segRight = canvasEnd.x - hlLeft
        const segY = canvasStart.y - 3 - hlTop

        segments.push({ type: 'free', path: encodeB64Path([
          { x: segLeft, y: segY, z: 0.5 },
          { x: segRight, y: segY, z: 0.5 },
        ])})
      }
    }

    // 6. Create highlight shape via putShape (on top of all existing shapes)
    const shapeId = `shape:hl-${Date.now().toString(36)}`
    const allRecords = getRoomRecords(syncRoomName(req.params.name), null)
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

export default router
