import { parentPort, workerData } from 'node:worker_threads'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const projectsDir = workerData.projectsDir
const projectFilesPath = join(projectsDir, '..', 'data', 'project-files.sqlite')
const projectFilesDb = existsSync(projectFilesPath)
  ? new Database(projectFilesPath, { readonly: true, fileMustExist: true })
  : null
const readManifest = projectFilesDb?.prepare(
  'SELECT path FROM project_files WHERE project = ? ORDER BY path',
)

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function watchFilesFor(project) {
  const relevant = readJson(
    join(projectsDir, project.name, 'output', 'relevant-files.json'),
  )
  let watchFiles = Array.isArray(relevant?.files)
    ? relevant.files.filter(file => typeof file === 'string' && file.length > 0)
    : null

  if (project.sourceDir) {
    const parts = readJson(
      join(projectsDir, project.name, 'source', '.tlda', 'parts.json'),
      { parts: [] },
    )
    const partFiles = (parts?.parts || [])
      .map(part => part?.metadata?.sourcePath)
      .filter(file => typeof file === 'string' && file.startsWith(`${project.sourceDir}/`))
      .map(file => file.slice(project.sourceDir.length + 1))
    if (partFiles.length > 0) {
      watchFiles = [...new Set([...(watchFiles || []), ...partFiles])]
    }
  }
  return watchFiles
}

function inventory() {
  if (!existsSync(projectsDir)) return []
  const projects = []
  for (const name of readdirSync(projectsDir)) {
    const project = readJson(join(projectsDir, name, 'project.json'))
    if (!project || project.archived) continue
    const authority = readJson(
      join(projectsDir, name, '.source-lifecycle', 'authority.json'),
      { currentRevision: null },
    )
    projects.push({
      name: project.name,
      sourceDir: project.sourceDir,
      format: project.format || 'svg',
      watchFiles: watchFilesFor(project),
      mainFile: project.mainFile || null,
      extraInputCommands: project.extraInputCommands || null,
      sourceRevision: authority?.currentRevision || null,
      sourceManifest: readManifest
        ? readManifest.all(project.name).map(row => row.path)
        : [],
    })
  }
  return projects
}

parentPort.postMessage({ kind: 'ready' })
parentPort.on('message', message => {
  if (message.kind === 'close') {
    projectFilesDb?.close()
    parentPort.postMessage({ id: message.id, result: true })
    return
  }
  try {
    if (message.method !== 'read') {
      throw new Error(`unknown daemon-project-inventory method: ${message.method}`)
    }
    parentPort.postMessage({ id: message.id, result: inventory() })
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: { message: error?.message || String(error), stack: error?.stack },
    })
  }
})
