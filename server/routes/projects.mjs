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
 *   POST   /:name/push          Push files + trigger build
 *   POST   /:name/build         Trigger rebuild
 *   GET    /:name/build/status  Build status + log
 */

import { Router } from 'express'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { requireRead, requireRw } from '../lib/auth.mjs'
import {
  createProject, readProject, updateProject, listProjects, deleteProject,
  listSourceFiles, hashSourceFiles, writeSourceFile, deleteSourceFile, readBuildLog, sourceDir,
  extractBuildErrors,
} from '../lib/project-store.mjs'
import { runBuild, getBuildStatus } from '../lib/build-runner.mjs'
import historyRoutes from './history.mjs'

const router = Router()

// Mount history sub-router
router.use('/:name/history', historyRoutes)

// List all projects
router.get('/', requireRead, (req, res) => {
  res.json({ projects: listProjects() })
})

// Create project
router.post('/', requireRw, (req, res) => {
  try {
    const { name, title, mainFile, sourceDir } = req.body
    if (!name) return res.status(400).json({ error: 'name is required' })
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return res.status(400).json({ error: 'name must be lowercase alphanumeric with hyphens' })
    }
    const project = createProject({ name, title, mainFile, sourceDir })
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

// Delete project
router.delete('/:name', requireRw, (req, res) => {
  try {
    deleteProject(req.params.name)
    res.json({ ok: true })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

// List source files
router.get('/:name/files', requireRead, (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  res.json({ files: listSourceFiles(req.params.name) })
})

// Source file hashes (for incremental push)
router.get('/:name/hashes', requireRead, (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  res.json({ hashes: hashSourceFiles(req.params.name) })
})

// Push files + trigger build
router.post('/:name/push', requireRw, async (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const { files, deletedFiles, priorityPages, sourceDir } = req.body

  // Update sourceDir if provided (so existing projects learn the path)
  if (sourceDir && !project.sourceDir) {
    updateProject(req.params.name, { sourceDir })
  }

  // Write files, track if anything actually changed
  let anyChanged = false
  if (files?.length > 0) {
    for (const file of files) {
      const content = file.encoding === 'base64'
        ? Buffer.from(file.content, 'base64')
        : file.content
      if (writeSourceFile(req.params.name, file.path, content)) {
        anyChanged = true
      }
    }
  }

  // Remove deleted files
  if (deletedFiles?.length > 0) {
    for (const filePath of deletedFiles) {
      if (deleteSourceFile(req.params.name, filePath)) {
        anyChanged = true
      }
    }
  }

  if (!anyChanged) {
    // Still rebuild if last build wasn't successful (e.g. patcher was broken, figures missing)
    if (project.buildStatus === 'success') {
      return res.json({ ok: true, filesWritten: 0, building: false, unchanged: true })
    }
  }

  // Respond immediately, build runs async
  res.json({ ok: true, filesWritten: files?.length || 0, building: true })

  try {
    await runBuild(req.params.name, { priorityPages })
  } catch (e) {
    console.error(`[api] Build failed for ${req.params.name}: ${e.message}`)
  }
})

// Trigger rebuild (no file changes)
router.post('/:name/build', requireRw, async (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const { priorityPages } = req.body || {}

  res.json({ ok: true, building: true })

  try {
    await runBuild(req.params.name, { priorityPages })
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

  res.json({
    building,
    status: project.buildStatus,
    lastBuild: project.lastBuild,
    errors: errors.map(e => e.message), // API returns flat strings for CLI compat
    warnings,
  })
})

export default router
