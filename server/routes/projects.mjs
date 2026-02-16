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
import {
  createProject, readProject, updateProject, listProjects, deleteProject,
  listSourceFiles, writeSourceFile, readBuildLog, sourceDir,
} from '../lib/project-store.mjs'
import { runBuild, getBuildStatus } from '../lib/build-runner.mjs'
import historyRoutes from './history.mjs'

const router = Router()

// Mount history sub-router
router.use('/:name/history', historyRoutes)

// List all projects
router.get('/', (req, res) => {
  res.json({ projects: listProjects() })
})

// Create project
router.post('/', (req, res) => {
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

  const { files, priorityPages, sourceDir } = req.body

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

  if (!anyChanged) {
    return res.json({ ok: true, filesWritten: 0, building: false, unchanged: true })
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

// LaTeX errors from the build log
router.get('/:name/build/errors', (req, res) => {
  const project = readProject(req.params.name)
  if (!project) return res.status(404).json({ error: 'Project not found' })

  const activeBuild = getBuildStatus(req.params.name)
  const building = activeBuild?.building || false

  // Find the .log file in source dir
  const srcDir = sourceDir(req.params.name)
  const mainBase = (project.mainFile || 'main.tex').replace(/\.tex$/, '')
  const logPath = join(srcDir, `${mainBase}.log`)

  if (!existsSync(logPath)) {
    return res.json({ building, status: project.buildStatus, errors: [], warnings: [] })
  }

  const logText = readFileSync(logPath, 'utf8')
  const lines = logText.split('\n')

  const errors = []
  const warnings = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // LaTeX errors start with !
    if (line.startsWith('!')) {
      // Collect context: the error line + next few lines (up to blank or next !)
      let msg = line
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (lines[j].startsWith('!') || lines[j] === '') break
        msg += '\n' + lines[j]
      }
      errors.push(msg)
    }
    // LaTeX warnings
    if (line.includes('LaTeX Warning:') || line.includes('Package natbib Warning:')) {
      // Skip common noise
      if (line.includes('Reference') || line.includes('Citation') || line.includes('Label(s) may have changed')) {
        warnings.push(line.trim())
      }
    }
    // Undefined control sequence (sometimes not prefixed with !)
    if (line.includes('Undefined control sequence')) {
      errors.push(line.trim())
    }
  }

  res.json({
    building,
    status: project.buildStatus,
    lastBuild: project.lastBuild,
    errors,
    warnings,
  })
})

export default router
