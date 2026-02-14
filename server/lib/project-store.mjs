/**
 * Project metadata storage.
 *
 * Projects live in server/projects/{name}/:
 *   project.json  — metadata (name, title, mainFile, pages, buildStatus, ...)
 *   source/       — uploaded tex/bib/sty/cls files
 *   output/       — build output (SVGs, lookup.json, macros.json, proof-info.json)
 *   build.log     — last build log
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join, relative } from 'path'

let projectsDir = null

export function initProjectStore(dir) {
  projectsDir = dir
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function getProjectsDir() {
  return projectsDir
}

export function listProjects() {
  if (!existsSync(projectsDir)) return []
  return readdirSync(projectsDir)
    .filter(name => existsSync(join(projectsDir, name, 'project.json')))
    .map(name => readProject(name))
    .filter(Boolean)
}

export function readProject(name) {
  const path = join(projectsDir, name, 'project.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function createProject({ name, title, mainFile = 'main.tex', format = 'svg' }) {
  const dir = join(projectsDir, name)
  if (existsSync(join(dir, 'project.json'))) {
    throw new Error(`Project "${name}" already exists`)
  }

  mkdirSync(join(dir, 'source'), { recursive: true })
  mkdirSync(join(dir, 'output'), { recursive: true })

  const project = {
    name,
    title: title || name,
    mainFile,
    format,
    pages: 0,
    createdAt: new Date().toISOString(),
    lastBuild: null,
    buildStatus: 'none',
  }

  writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2))
  return project
}

export function updateProject(name, updates) {
  const project = readProject(name)
  if (!project) throw new Error(`Project "${name}" not found`)

  Object.assign(project, updates)
  writeFileSync(
    join(projectsDir, name, 'project.json'),
    JSON.stringify(project, null, 2),
  )
  return project
}

export function deleteProject(name) {
  const dir = join(projectsDir, name)
  if (!existsSync(join(dir, 'project.json'))) {
    throw new Error(`Project "${name}" not found`)
  }
  rmSync(dir, { recursive: true })
}

export function projectDir(name) {
  return join(projectsDir, name)
}

export function sourceDir(name) {
  return join(projectsDir, name, 'source')
}

export function outputDir(name) {
  return join(projectsDir, name, 'output')
}

// Build artifacts that latexmk leaves in the source directory
const BUILD_JUNK = new Set([
  '.aux', '.log', '.out', '.synctex.gz', '.fls', '.fdb_latexmk',
  '.bbl', '.blg', '.bcf', '.run.xml', '.toc', '.lof', '.lot',
  '.nav', '.snm', '.vrb', '.dvi', '.pdf', '.fmt',
])

export function listSourceFiles(name) {
  const dir = sourceDir(name)
  if (!existsSync(dir)) return []
  return walkDir(dir)
    .map(f => relative(dir, f))
    .filter(f => {
      const ext = '.' + f.split('.').pop()
      return !BUILD_JUNK.has(ext)
    })
}

function walkDir(dir) {
  const results = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walkDir(full))
    } else {
      results.push(full)
    }
  }
  return results
}

/**
 * Write a source file. Returns true if the file was actually changed.
 */
export function writeSourceFile(name, filePath, content) {
  const dir = sourceDir(name)
  const full = join(dir, filePath)
  // Prevent path traversal
  if (!full.startsWith(dir)) throw new Error('Invalid file path')
  const parent = join(full, '..')
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  // Skip write if content is identical
  if (existsSync(full)) {
    const existing = readFileSync(full)
    const incoming = Buffer.isBuffer(content) ? content : Buffer.from(content)
    if (existing.equals(incoming)) return false
  }
  writeFileSync(full, content)
  return true
}

export function readBuildLog(name) {
  const logPath = join(projectsDir, name, 'build.log')
  if (!existsSync(logPath)) return null
  return readFileSync(logPath, 'utf8')
}
