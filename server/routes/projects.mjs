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
import {
  createProject, readProject, listProjects, deleteProject,
  listSourceFiles, writeSourceFile, readBuildLog,
} from '../lib/project-store.mjs'
import { runBuild, getBuildStatus } from '../lib/build-runner.mjs'

const router = Router()

// List all projects
router.get('/', (req, res) => {
  res.json({ projects: listProjects() })
})

// Create project
router.post('/', (req, res) => {
  try {
    const { name, title, mainFile } = req.body
    if (!name) return res.status(400).json({ error: 'name is required' })
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return res.status(400).json({ error: 'name must be lowercase alphanumeric with hyphens' })
    }
    const project = createProject({ name, title, mainFile })
    res.status(201).json(project)
  } catch (e) {
    res.status(409).json({ error: e.message })
  }
})

// Get project
router.get('/:name', (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const activeBuild = getBuildStatus(req.params.name)
  res.json({
    ...project,
    ...(activeBuild?.building && { activeBuild }),
  })
})

// Delete project
router.delete('/:name', (req, res) => {
  try {
    deleteProject(req.params.name)
    res.json({ ok: true })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

// List source files
router.get('/:name/files', (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })
  res.json({ files: listSourceFiles(req.params.name) })
})

// Push files + trigger build
router.post('/:name/push', async (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const { files, priorityPages } = req.body

  // Write files
  if (files?.length > 0) {
    for (const file of files) {
      const content = file.encoding === 'base64'
        ? Buffer.from(file.content, 'base64')
        : file.content
      writeSourceFile(req.params.name, file.path, content)
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
router.post('/:name/build', async (req, res) => {
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
router.get('/:name/build/status', (req, res) => {
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

export default router
