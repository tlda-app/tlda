import { parentPort, workerData } from 'node:worker_threads'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import winkNLP from 'wink-nlp'
import model from 'wink-eng-lite-web-model'
import BM25Vectorizer from 'wink-nlp/utilities/bm25-vectorizer.js'
import winkIts from 'wink-nlp/src/its.js'

import { normalizeSourceManifest, sourceManifestContext } from '../../shared/source-manifest.mjs'
import { resolveContainedPath } from './path-containment.mjs'
import { checkpointProjectPartWriteback } from './project-part-writeback.mjs'

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
const nlp = winkNLP(model)

const normalizeSearchText = (value) => String(value || '').replace(/\s+/g, ' ').trim()

const documentSearchExcerpt = (text, query, terms, max = 260) => {
  const normalized = normalizeSearchText(text)
  if (!normalized) return ''
  const lower = normalized.toLowerCase()
  const needles = [query, ...terms].map(s => String(s || '').toLowerCase()).filter(Boolean)
  let idx = needles.map(needle => lower.indexOf(needle)).find(i => i >= 0)
  if (idx == null || idx < 0) idx = 0
  const start = Math.max(0, idx - Math.floor(max / 3))
  const end = Math.min(normalized.length, start + max)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < normalized.length ? '…' : ''
  return `${prefix}${normalized.slice(start, end)}${suffix}`
}

const sourceSearchFiles = new Set(['.tex', '.bib', '.sty', '.cls', '.md', '.qmd', '.html', '.txt'])

const sourceSearchExt = (file) => {
  const match = String(file || '').match(/(\.[^./]+)$/)
  return match ? match[1].toLowerCase() : ''
}

const documentSearchScore = ({ project, title, label, text }, query, terms, currentProject) => {
  const hay = `${title || ''} ${label || ''} ${text || ''}`.toLowerCase()
  const q = query.toLowerCase()
  let score = 0
  if (q && hay.includes(q)) score += 80
  for (const term of terms) if (term && hay.includes(term)) score += 12
  if (title?.toLowerCase?.().includes(q)) score += 30
  if (label?.toLowerCase?.().includes(q)) score += 12
  if (project && currentProject && project === currentProject) score += 35
  return score
}

function readProjectSourceSearchEntries(project) {
  const name = project?.name
  if (!name) return []
  const sourceRoot = resolve(projectsDir, name, 'source')
  const files = read.all(name)
    .map(row => row.path)
    .filter(file => sourceSearchFiles.has(sourceSearchExt(file)))
    .slice(0, 80)
  return files.map((file, index) => {
    let text = ''
    try {
      const sourcePath = resolveContainedPath(sourceRoot, file)
      if (existsSync(sourcePath)) text = readFileSync(sourcePath, 'utf8')
    } catch {
      text = ''
    }
    if (text.length > 80_000) text = text.slice(0, 80_000)
    return {
      sourceKind: 'source',
      index,
      project: name,
      title: project.title || name,
      page: null,
      file,
      label: file,
      anchor: null,
      text,
    }
  })
}

function documentAssociationTokens(text) {
  return nlp.readDoc(text)
    .tokens()
    .filter(token => token.out(nlp.its.type) === 'word' && !token.out(nlp.its.stopWordFlag))
    .out(nlp.its.stem)
}

function materializedSourceFile(project, outputFile) {
  const manifestPath = join(projectsDir, project, 'source', '.tlda', 'parts.json')
  if (!existsSync(manifestPath)) return null
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const part = (manifest.parts || []).find(item => {
      const source = String(item.path || item.storage?.path || '').replace(/\\/g, '/')
      return source.replace(/\.(md|markdown)$/i, '.html') === outputFile
    })
    return part ? String(part.path || part.storage?.path || '') : null
  } catch {
    return null
  }
}

function documentText(project, document) {
  if (document.kind === 'shared') return String(document.text || '').slice(0, 240_000)
  if (document.kind === 'materialized') {
    const sourceFile = materializedSourceFile(project.name, String(document.path || ''))
    if (!sourceFile) return ''
    try {
      const sourcePath = resolveContainedPath(resolve(projectsDir, project.name, 'source'), sourceFile)
      return existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8').slice(0, 240_000) : ''
    } catch {
      return ''
    }
  }
  return readProjectSourceSearchEntries(project).map(entry => entry.text).join('\n')
}

function documentAssociations(projectName, requestedDocuments) {
  const topK = 3
  const threshold = 0.15
  const project = readProject(projectName)
  if (!project) throw new Error(`Project "${projectName}" not found`)
  const documents = (Array.isArray(requestedDocuments) ? requestedDocuments : [])
    .slice(0, 100)
    .map(document => {
      const id = String(document?.id || '')
      const kind = ['primary', 'materialized', 'shared'].includes(document?.kind) ? document.kind : null
      if (!id || !kind) return null
      return { id, tokens: documentAssociationTokens(documentText(project, { ...document, kind })) }
    })
    .filter(document => document?.tokens.length > 0)
  if (documents.length < 2) return []

  const vectorizer = BM25Vectorizer({ norm: 'l2' })
  for (const document of documents) vectorizer.learn(document.tokens)
  const vectors = documents.map((_, index) => vectorizer.doc(index).out(winkIts.vector))
  const selected = new Map()
  for (let i = 0; i < documents.length; i++) {
    const neighbors = []
    for (let j = 0; j < documents.length; j++) {
      if (i === j) continue
      let weight = 0
      for (let term = 0; term < vectors[i].length; term++) {
        weight += vectors[i][term] * vectors[j][term]
      }
      if (weight >= threshold) neighbors.push({ index: j, weight })
    }
    neighbors
      .sort((a, b) => (b.weight - a.weight) || documents[a.index].id.localeCompare(documents[b.index].id))
      .slice(0, topK)
      .forEach(({ index, weight }) => {
        const source = documents[i].id
        const target = documents[index].id
        const [a, b] = source < target ? [source, target] : [target, source]
        const key = `${a}\0${b}`
        selected.set(key, Math.max(selected.get(key) || 0, weight))
      })
  }
  return [...selected.entries()]
    .map(([key, weight]) => {
      const [source, target] = key.split('\0')
      return { source, target, weight: Number(weight.toFixed(6)) }
    })
    .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
}

function searchContent(query, options = {}) {
  const q = normalizeSearchText(query)
  if (q.length < 2) return []
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 50
  const currentProject = String(options.currentProject || '').trim()
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  const projects = listProjects()
    .filter(p => p?.name && !p.archived)
    .slice(0, 200)
  const rows = []
  for (const project of projects) {
    const entries = readProjectSourceSearchEntries(project)
    for (const entry of entries) {
      const hay = `${entry.title || ''} ${entry.label || ''} ${entry.text || ''}`.toLowerCase()
      if (!terms.every(term => hay.includes(term))) continue
      const score = documentSearchScore(entry, q, terms, currentProject)
      if (score <= 0) continue
      const snippet = documentSearchExcerpt(entry.text || entry.label || entry.title, q, terms)
      const timestamp = project.lastBuild || project.updatedAt || project.createdAt || null
      rows.push({
        source: 'project',
        type: 'document_content',
        id: `document:${entry.project}:${entry.sourceKind}:${entry.page || entry.file || entry.index}:${entry.anchor || ''}`,
        timestamp,
        project: entry.project,
        doc: entry.project,
        title: entry.title || entry.project,
        text: snippet,
        snippet,
        page: entry.page,
        file: entry.file || null,
        label: entry.label,
        anchor: entry.anchor,
        sourceKind: entry.sourceKind,
        score,
      })
    }
  }
  return rows
    .sort((a, b) => (b.score - a.score) || ((b.timestamp || '').localeCompare(a.timestamp || '')) || a.project.localeCompare(b.project))
    .slice(0, limit)
}

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

function snapshotModifiedAt(project) {
  const snapshot = join(projectsDir, project, 'sync-snapshot.json')
  if (!existsSync(snapshot)) return null
  try {
    return statSync(snapshot).mtime.toISOString()
  } catch {
    return null
  }
}

function projectMeta() {
  return Object.fromEntries(listProjects().map(project => {
    const lastAnnotated = snapshotModifiedAt(project.name)
    return [
      project.name,
      {
        ...(project.lastBuild && { lastBuild: project.lastBuild }),
        ...(lastAnnotated && { lastAnnotated }),
      },
    ]
  }))
}

function updateProject(projectName, updates) {
  const project = readProject(projectName)
  if (!project) throw new Error(`Project "${projectName}" not found`)
  Object.assign(project, updates)
  writeFileSync(join(projectsDir, projectName, 'project.json'), JSON.stringify(project, null, 2))
  return project
}

migrateLegacyClientSourceManifests()

function checkpointProjectPart(payload) {
  const { nowValue, ...options } = payload || {}
  return checkpointProjectPartWriteback({
    ...options,
    ...(nowValue ? { now: () => nowValue } : {}),
  })
}

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
      : message.method === 'project-meta'
        ? projectMeta()
      : message.method === 'read-project'
        ? readProject(message.project)
        : message.method === 'update-project'
          ? updateProject(message.project, message.updates)
          : message.method === 'read'
            ? read.all(message.project).map(row => row.path)
            : message.method === 'replace'
              ? (replace(message.project, message.paths), true)
              : message.method === 'searchContent'
                ? searchContent(message.query, message.options)
              : message.method === 'documentAssociations'
                  ? documentAssociations(message.project, message.documents)
                  : message.method === 'checkpoint-project-part'
                    ? checkpointProjectPart(message.payload)
                : (() => { throw new Error(`unknown project-files method: ${message.method}`) })()
    parentPort.postMessage({ id: message.id, result })
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: { message: error?.message || String(error), stack: error?.stack },
    })
  }
})
