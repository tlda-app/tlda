import { parentPort, workerData } from 'node:worker_threads'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

import { normalizeSourceManifest, sourceManifestContext } from '../../shared/source-manifest.mjs'

const projectsDir = workerData.projectsDir
const dataDir = join(projectsDir, '..', 'data')
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
const db = new Database(join(dataDir, 'project-files.sqlite'))
db.pragma('auto_vacuum = INCREMENTAL')
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')
db.pragma('wal_autocheckpoint = 1000')
db.pragma('journal_size_limit = 67108864')
db.exec(`
  CREATE TABLE IF NOT EXISTS project_files (
    project TEXT NOT NULL,
    path TEXT NOT NULL,
    PRIMARY KEY (project, path)
  );
  CREATE INDEX IF NOT EXISTS project_files_path_project
    ON project_files(path, project);
`)

const count = db.prepare('SELECT COUNT(*) AS count FROM project_files WHERE project = ?')
const read = db.prepare('SELECT path FROM project_files WHERE project = ? ORDER BY path')
const remove = db.prepare('DELETE FROM project_files WHERE project = ?')
const insert = db.prepare('INSERT INTO project_files (project, path) VALUES (?, ?)')
const seedInsert = db.prepare('INSERT OR IGNORE INTO project_files (project, path) VALUES (?, ?)')
const replace = db.transaction((project, paths) => {
  remove.run(project)
  for (const filePath of paths) insert.run(project, filePath)
})
const seed = db.transaction((project, paths) => {
  for (const filePath of paths) seedInsert.run(project, filePath)
})

function migrateLegacyClientSourceManifests() {
  if (!existsSync(projectsDir)) return
  for (const name of readdirSync(projectsDir)) {
    const projectPath = join(projectsDir, name, 'project.json')
    if (!existsSync(projectPath)) continue
    let project
    try {
      project = JSON.parse(readFileSync(projectPath, 'utf8'))
    } catch {
      continue
    }
    if (Array.isArray(project.clientSourceManifest) && count.get(name).count === 0) {
      seed(name, normalizeSourceManifest(project.clientSourceManifest, sourceManifestContext(project)))
    }
    if (Object.prototype.hasOwnProperty.call(project, 'clientSourceManifest')) {
      delete project.clientSourceManifest
      writeFileSync(projectPath, JSON.stringify(project, null, 2))
    }
  }
}

function readProject(project) {
  const projectPath = join(projectsDir, project, 'project.json')
  if (!existsSync(projectPath)) return null
  try {
    return JSON.parse(readFileSync(projectPath, 'utf8'))
  } catch {
    return null
  }
}

function listProjects() {
  if (!existsSync(projectsDir)) return []
  return readdirSync(projectsDir)
    .map(readProject)
    .filter(Boolean)
}

function updateProject(projectName, updates) {
  const project = readProject(projectName)
  if (!project) throw new Error(`Project "${projectName}" not found`)
  Object.assign(project, updates)
  writeFileSync(join(projectsDir, projectName, 'project.json'), JSON.stringify(project, null, 2))
  return project
}

migrateLegacyClientSourceManifests()
parentPort.postMessage({ kind: 'ready' })

parentPort.on('message', (message) => {
  if (message.kind === 'close') {
    db.close()
    parentPort.postMessage({ id: message.id, result: true })
    return
  }
  try {
    const result = message.method === 'list-projects'
      ? listProjects()
      : message.method === 'read-project'
        ? readProject(message.project)
        : message.method === 'update-project'
          ? updateProject(message.project, message.updates)
          : message.method === 'read'
            ? read.all(message.project).map(row => row.path)
            : message.method === 'replace'
              ? (replace(message.project, message.paths), true)
              : (() => { throw new Error(`unknown project-files method: ${message.method}`) })()
    parentPort.postMessage({ id: message.id, result })
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: { message: error?.message || String(error), stack: error?.stack },
    })
  }
})
