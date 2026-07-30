/**
 * Project metadata storage.
 *
 * Projects live in server/projects/{name}/:
 *   project.json  — metadata (name, title, mainFile, pages, buildStatus, ...)
 *   source/       — uploaded tex/bib/sty/cls files
 *   output/       — build output (SVGs, lookup.json, macros.json, proof-info.json)
 *   build.log     — last build log
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, unlinkSync, realpathSync, cpSync, renameSync, openSync, fsyncSync, closeSync, statSync } from 'fs'
import { access, mkdir, readFile, readdir, unlink, writeFile } from 'fs/promises'
import { join, relative, dirname } from 'path'
import { createHash, randomUUID } from 'crypto'
import { isSourceFilePath, isIgnoredSourceDir, normalizeSourceManifest, sourceManifestContext } from '../../shared/source-manifest.mjs'
import {
  projectPartsManifestPath as partsManifestPathForRoot,
  readProjectPartsManifest as readPartsManifestForRoot,
  readProjectPartsManifestAsync as readPartsManifestForRootAsync,
  recoverProjectPartsManifest as recoverPartsManifestForRoot,
  writeProjectPartsManifest as writePartsManifestForRoot,
} from './project-parts-scanner.mjs'
import { resolveContainedPath } from './path-containment.mjs'
import { createSourceLifecycleStore } from './source-lifecycle.mjs'
import { ProjectFilesStoreClient } from './project-files-store-client.mjs'

let projectsDir = null
let projectFilesDb = null

export async function initProjectStore(dir) {
  if (projectFilesDb) await projectFilesDb.close()
  projectsDir = dir
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  projectFilesDb = new ProjectFilesStoreClient(dir)
  await projectFilesDb.ready()
}

export function getProjectsDir() {
  return projectsDir
}

export async function closeProjectStore() {
  if (!projectFilesDb) return
  await projectFilesDb.close()
  projectFilesDb = null
}
export async function listProjects() {
  if (!projectFilesDb) throw new Error('project store is not initialized')
  return (await projectFilesDb.listProjects()).map(({ sourceDir: _sourceDir, ...project }) => project)
}

export async function readProjectMeta() {
  if (!projectFilesDb) throw new Error('project store is not initialized')
  return projectFilesDb.projectMeta()
}

export async function readProject(name) {
  if (!projectFilesDb) throw new Error('project store is not initialized')
  const project = await projectFilesDb.readProject(name)
  if (!project) return project
  const { sourceDir: _sourceDir, ...sharedProject } = project
  return sharedProject
}

export function createProject({ name, title, mainFile = 'main.tex', format = 'svg', members }) {
  const dir = join(projectsDir, name)
  if (existsSync(join(dir, 'project.json'))) {
    throw new Error(`Project "${name}" already exists`)
  }

  mkdirSync(join(dir, 'source'), { recursive: true })
  mkdirSync(join(dir, 'output'), { recursive: true })

  const isBook = format === 'book'
  const project = {
    name,
    title: title || name,
    ...(!isBook && { mainFile }),
    format,
    ...(isBook && members && { members }),
    pages: 0,
    createdAt: new Date().toISOString(),
    lastBuild: null,
    buildStatus: isBook ? 'success' : 'none',  // books don't need builds
  }

  writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2))
  return project
}

export async function updateProject(name, updates) {
  if (Object.prototype.hasOwnProperty.call(updates, 'clientSourceManifest')) {
    throw new Error('clientSourceManifest is stored in project_files; use updateClientSourceManifest()')
  }
  if (!projectFilesDb) throw new Error('project store is not initialized')
  const project = await projectFilesDb.updateProject(name, { ...updates, sourceDir: undefined })
  if (!project) return project
  const { sourceDir: _sourceDir, ...sharedProject } = project
  return sharedProject
}

/**
 * Snapshot the mutable source-transaction surfaces. The returned transaction
 * must be committed or rolled back exactly once. Rollback is deliberately not
 * best-effort: a restore failure is a fatal transaction failure.
 */
function syncPath(path, durabilityProbe, label) {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
    durabilityProbe?.(label, path)
  } finally {
    closeSync(fd)
  }
}

function syncTree(root, durabilityProbe) {
  if (!existsSync(root)) return
  if (!statSync(root).isDirectory()) {
    syncPath(root, durabilityProbe, 'snapshot-file')
    return
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    syncTree(join(root, entry.name), durabilityProbe)
  }
  syncPath(root, durabilityProbe, 'snapshot-directory')
}

function writeRecoveryJournal(snapshotRoot, journal, durabilityProbe) {
  const target = join(snapshotRoot, 'recovery.json')
  const pending = join(snapshotRoot, `.recovery.json.pending-${process.pid}-${randomUUID()}`)
  writeFileSync(pending, JSON.stringify(journal, null, 2))
  syncPath(pending, durabilityProbe, 'journal-temp-file')
  renameSync(pending, target)
  syncPath(target, durabilityProbe, 'journal-file')
  syncPath(snapshotRoot, durabilityProbe, 'journal-directory')
}

export async function beginProjectSourceTransaction(name, { originalLocalHead = null, failJournalWrite = false, durabilityProbe = null } = {}) {
  const dir = projectDir(name)
  const id = randomUUID()
  const transactionRoot = join(dir, '.source-transactions')
  const snapshotRoot = join(transactionRoot, id)
  mkdirSync(snapshotRoot, { recursive: true })
  const source = sourceDir(name)
  const metadata = join(dir, 'project.json')
  const clone = join(dir, 'overleaf-clone')
  const lifecycleAuthority = join(dir, '.source-lifecycle', 'authority.json')
  const manifest = await readClientSourceManifest(name)
  if (existsSync(source)) cpSync(source, join(snapshotRoot, 'source'), { recursive: true, preserveTimestamps: true })
  cpSync(metadata, join(snapshotRoot, 'project.json'), { preserveTimestamps: true })
  writeFileSync(join(snapshotRoot, 'client-source-manifest.json'), JSON.stringify(manifest, null, 2))
  if (existsSync(clone)) {
    const cloneSnapshot = join(snapshotRoot, 'overleaf-worktree')
    mkdirSync(cloneSnapshot, { recursive: true })
    for (const entry of readdirSync(clone, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      cpSync(join(clone, entry.name), join(cloneSnapshot, entry.name), { recursive: true, preserveTimestamps: true })
    }
  }
  if (existsSync(lifecycleAuthority)) cpSync(lifecycleAuthority, join(snapshotRoot, 'source-lifecycle-authority.json'), { preserveTimestamps: true })
  syncTree(snapshotRoot, durabilityProbe)
  syncPath(transactionRoot, durabilityProbe, 'transaction-parent-directory')
  syncPath(dir, durabilityProbe, 'project-directory')
  if (failJournalWrite) {
    writeFileSync(join(snapshotRoot, '.recovery.json.pending-injected'), '{')
    throw new Error('Injected crash during recovery journal creation')
  }
  writeRecoveryJournal(snapshotRoot, {
    version: 1,
    project: name,
    state: 'snapshot-ready',
    originalLocalHead,
  }, durabilityProbe)
  syncPath(transactionRoot, durabilityProbe, 'transaction-parent-directory')
  syncPath(dir, durabilityProbe, 'project-directory')
  let finished = false

  return {
    identity() {
      return { id, state: 'snapshot-ready' }
    },
    recordRemotePlan(plan) {
      if (finished) throw new Error('Source transaction already finished')
      writeRecoveryJournal(snapshotRoot, {
        version: 1,
        project: name,
        state: 'publish-pending',
        originalLocalHead,
        ...plan,
      }, durabilityProbe)
      return { id, state: 'publish-pending' }
    },
    commit() {
      if (finished) throw new Error('Source transaction already finished')
      rmSync(snapshotRoot, { recursive: true })
      finished = true
    },
    async rollback() {
      if (finished) throw new Error('Source transaction already finished')
      rmSync(source, { recursive: true, force: true })
      if (existsSync(join(snapshotRoot, 'source'))) cpSync(join(snapshotRoot, 'source'), source, { recursive: true, preserveTimestamps: true })
      const metadataRestore = join(dir, `.project.json.rollback-${process.pid}-${Date.now()}`)
      cpSync(join(snapshotRoot, 'project.json'), metadataRestore, { preserveTimestamps: true })
      renameSync(metadataRestore, metadata)
      await restoreClientSourceManifestSnapshot(name, snapshotRoot)
      restoreCloneWorktree(clone, join(snapshotRoot, 'overleaf-worktree'))
      rmSync(lifecycleAuthority, { force: true })
      if (existsSync(join(snapshotRoot, 'source-lifecycle-authority.json'))) {
        mkdirSync(dirname(lifecycleAuthority), { recursive: true })
        cpSync(join(snapshotRoot, 'source-lifecycle-authority.json'), lifecycleAuthority, { preserveTimestamps: true })
      }
      finished = true
      rmSync(snapshotRoot, { recursive: true })
    },
    abandon() {
      if (finished) throw new Error('Source transaction already finished')
      finished = true
      return { id, state: 'recovery-required' }
    },
  }
}

function restoreCloneWorktree(clone, snapshot) {
  if (!existsSync(clone)) return
  for (const entry of readdirSync(clone, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    rmSync(join(clone, entry.name), { recursive: true, force: true })
  }
  if (!existsSync(snapshot)) return
  for (const entry of readdirSync(snapshot, { withFileTypes: true })) {
    cpSync(join(snapshot, entry.name), join(clone, entry.name), { recursive: true, preserveTimestamps: true })
  }
}

export function listProjectSourceRecoveries(name) {
  const root = join(projectDir(name), '.source-transactions')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const journal = join(root, entry.name, 'recovery.json')
      if (!existsSync(journal)) return { id: entry.name, state: 'journal-incomplete' }
      return { id: entry.name, ...JSON.parse(readFileSync(journal, 'utf8')) }
    })
}

export async function rollbackProjectSourceRecovery(name, id) {
  const dir = projectDir(name)
  const snapshotRoot = join(dir, '.source-transactions', id)
  const source = sourceDir(name)
  const metadata = join(dir, 'project.json')
  rmSync(source, { recursive: true, force: true })
  if (existsSync(join(snapshotRoot, 'source'))) cpSync(join(snapshotRoot, 'source'), source, { recursive: true, preserveTimestamps: true })
  const metadataRestore = join(dir, `.project.json.rollback-${process.pid}-${Date.now()}`)
  cpSync(join(snapshotRoot, 'project.json'), metadataRestore, { preserveTimestamps: true })
  renameSync(metadataRestore, metadata)
  await restoreClientSourceManifestSnapshot(name, snapshotRoot)
  restoreCloneWorktree(join(dir, 'overleaf-clone'), join(snapshotRoot, 'overleaf-worktree'))
  const lifecycleAuthority = join(dir, '.source-lifecycle', 'authority.json')
  rmSync(lifecycleAuthority, { force: true })
  if (existsSync(join(snapshotRoot, 'source-lifecycle-authority.json'))) {
    mkdirSync(dirname(lifecycleAuthority), { recursive: true })
    cpSync(join(snapshotRoot, 'source-lifecycle-authority.json'), lifecycleAuthority, { preserveTimestamps: true })
  }
}

export function removeProjectSourceRecovery(name, id) {
  rmSync(join(projectDir(name), '.source-transactions', id), { recursive: true })
}

/**
 * Add a member to a book project, creating the book if it doesn't exist.
 * Deduplicates members. Returns the updated project.
 */
export async function addBookMember(bookName, memberName) {
  let book = await readProject(bookName)
  if (!book) {
    book = createProject({ name: bookName, title: bookName, format: 'book', members: [memberName] })
  } else {
    const members = Array.from(new Set([...(book.members || []), memberName]))
    book = await updateProject(bookName, { members })
  }
  aggregateBookToc(bookName, book.members || [memberName])
  return book
}

export function aggregateBookToc(bookName, members) {
  const bookOutDir = outputDir(bookName)
  mkdirSync(bookOutDir, { recursive: true })

  const LEVEL_UP = { section: 'subsection', subsection: 'subsubsection', subsubsection: 'subsubsection' }
  const bookToc = []

  for (const key of members) {
    const memberTocPath = join(outputDir(key), 'toc.json')
    let memberToc = []
    if (existsSync(memberTocPath)) {
      try { memberToc = JSON.parse(readFileSync(memberTocPath, 'utf8')) } catch {}
    }

    // If the member's toc starts with a top-level section, promote it to the chapter title
    // and skip it from the nested entries (avoids "kernel-is-free / The kernel is free" redundancy)
    let chapterTitle = key
    let chapterAnchor = undefined
    let startIdx = 0
    if (memberToc.length > 0 && memberToc[0].level === 'section') {
      chapterTitle = memberToc[0].title
      chapterAnchor = memberToc[0].anchor
      startIdx = 1
    }

    bookToc.push({ title: chapterTitle, level: 'chapter', page: 1, targetFile: key, ...(chapterAnchor && { anchor: chapterAnchor }) })

    for (let i = startIdx; i < memberToc.length; i++) {
      const entry = memberToc[i]
      // Demote levels: section→subsection, subsection→subsubsection
      const newLevel = LEVEL_UP[entry.level] || entry.level
      bookToc.push({ title: entry.title, level: newLevel, page: 1, anchor: entry.anchor, targetFile: key })
    }
  }

  writeFileSync(join(bookOutDir, 'toc.json'), JSON.stringify(bookToc, null, 2))
}

export async function deleteProject(name) {
  const dir = join(projectsDir, name)
  if (!existsSync(join(dir, 'project.json'))) {
    throw new Error(`Project "${name}" not found`)
  }
  rmSync(dir, { recursive: true })
  await projectFilesDb.replace(name, [])
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

// Dormant authority store for the lifecycle rollout. Current ingress paths do
// not call this until the revision contract is wired atomically in Phase B.
export async function sourceLifecycleStore(name, options = {}) {
  if (!await readProject(name)) throw new Error(`Project "${name}" not found`)
  return createSourceLifecycleStore({
    root: join(projectDir(name), '.source-lifecycle'),
    context: sourceManifestContext(await readProject(name)),
    ...options,
  })
}

export function projectPartsRoot(name) {
  return sourceDir(name)
}

export function projectPartsManifestPath(name) {
  return partsManifestPathForRoot(projectPartsRoot(name))
}

export async function readProjectPartsManifest(name) {
  if (!await readProject(name)) throw new Error(`Project "${name}" not found`)
  return readPartsManifestForRootAsync(projectPartsRoot(name))
}

export async function writeProjectPartsManifest(name, manifest) {
  if (!await readProject(name)) throw new Error(`Project "${name}" not found`)
  return writePartsManifestForRoot(projectPartsRoot(name), manifest)
}

export async function recoverProjectPartsManifest(name, options = {}) {
  if (!await readProject(name)) throw new Error(`Project "${name}" not found`)
  return recoverPartsManifestForRoot(projectPartsRoot(name), options)
}

export async function listSourceFiles(name) {
  const dir = sourceDir(name)
  if (!await pathExists(dir)) return []
  const project = await readProject(name)
  const context = sourceManifestContext(project || {})
  const owned = await clientOwnedSourceSet(project)
  return (await walkDirAsync(dir))
    .map(f => relative(dir, f))
    .filter(f => isClientSourcePath(f, context, owned))
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readTextOrNull(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function walkDirAsync(dir) {
  const results = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (isIgnoredSourceDir(entry.name)) continue
      results.push(...await walkDirAsync(full))
    } else {
      results.push(full)
    }
  }
  return results
}

function walkDir(dir) {
  const results = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (isIgnoredSourceDir(entry.name)) continue
      results.push(...walkDir(full))
    } else {
      results.push(full)
    }
  }
  return results
}

/**
 * Get MD5 hashes of all source files. Returns { "path": "hex", ... }
 */
export async function hashSourceFiles(name) {
  const dir = sourceDir(name)
  if (!await pathExists(dir)) return {}
  const project = await readProject(name)
  const context = sourceManifestContext(project || {})
  const owned = await clientOwnedSourceSet(project)
  const hashes = {}
  for (const full of await walkDirAsync(dir)) {
    const rel = relative(dir, full)
    if (!isClientSourcePath(rel, context, owned)) continue
    hashes[rel] = createHash('md5').update(await readFile(full)).digest('hex')
  }
  return hashes
}

async function clientOwnedSourceSet(project) {
  if (!project?.name) return new Set()
  return new Set(await readClientSourceManifest(project.name))
}

// Client-owned means authored source supplied by an external authoring ingress
// (CLI push, daemon watcher, Overleaf sync). Server-generated and server-seeded
// files stay outside this manifest and cannot be explicit client deletions.
function isClientSourcePath(rel, context, owned) {
  if (!isSourceFilePath(rel, context)) return false
  return owned.has(rel)
}

export async function isClientOwnedSourcePath(name, filePath) {
  const project = await readProject(name)
  const owned = await clientOwnedSourceSet(project)
  return !!owned && owned.has(filePath)
}

export async function readClientSourceManifest(name) {
  if (!await readProject(name)) throw new Error(`Project "${name}" not found`)
  return projectFilesDb.read(name)
}

export async function searchProjectContent(query, options = {}) {
  if (!projectFilesDb) throw new Error('Project store is not initialized')
  return projectFilesDb.searchContent(query, options)
}

export async function listDocumentAssociations(project, documents) {
  if (!projectFilesDb) throw new Error('Project store is not initialized')
  return projectFilesDb.documentAssociations(project, documents)
}

export async function updateClientSourceManifest(name, sourceManifest) {
  const project = await readProject(name)
  if (!project) throw new Error(`Project "${name}" not found`)
  const context = sourceManifestContext(project)
  await replaceClientSourceManifestRows(name, normalizeSourceManifest(sourceManifest, context))
}

async function replaceClientSourceManifestRows(name, manifest) {
  await projectFilesDb.replace(name, manifest)
}

async function restoreClientSourceManifestSnapshot(name, snapshotRoot) {
  const snapshot = join(snapshotRoot, 'client-source-manifest.json')
  let manifest = []
  if (existsSync(snapshot)) {
    manifest = JSON.parse(readFileSync(snapshot, 'utf8'))
  } else {
    const legacyProjectJson = join(snapshotRoot, 'project.json')
    if (existsSync(legacyProjectJson)) {
      const project = JSON.parse(readFileSync(legacyProjectJson, 'utf8'))
      if (Array.isArray(project.clientSourceManifest)) {
        manifest = normalizeSourceManifest(project.clientSourceManifest, sourceManifestContext(project))
      }
    }
  }
  await replaceClientSourceManifestRows(name, manifest)
}

/**
 * Write a source file. Returns true if the file was actually changed.
 */
export function writeSourceFile(name, filePath, content) {
  const full = sourceFilePath(name, filePath)
  const parent = dirname(full)
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

/**
 * Read a source file. Returns the file content as a string, or null if not found.
 */
export function readSourceFile(name, filePath) {
  const full = sourceFilePath(name, filePath)
  if (!existsSync(full)) return null
  return readFileSync(full, 'utf8')
}

export async function readSourceFileAsync(name, filePath) {
  const full = sourceFilePath(name, filePath)
  if (!await pathExists(full)) return null
  return readFile(full, 'utf8')
}

/**
 * Delete a source file. Returns true if the file existed and was removed.
 */
export function deleteSourceFile(name, filePath) {
  const full = sourceFilePath(name, filePath)
  if (!existsSync(full)) return false
  unlinkSync(full)
  return true
}

export async function deleteSourceFileAsync(name, filePath) {
  const full = sourceFilePath(name, filePath)
  if (!await pathExists(full)) return false
  await unlink(full)
  return true
}

export async function writeSourceFileAsync(name, filePath, content) {
  const full = sourceFilePath(name, filePath)
  const parent = dirname(full)
  if (!await pathExists(parent)) await mkdir(parent, { recursive: true })
  if (await pathExists(full)) {
    const existing = await readFile(full)
    const incoming = Buffer.isBuffer(content) ? content : Buffer.from(content)
    if (existing.equals(incoming)) return false
  }
  await writeFile(full, content)
  return true
}

export function validateSourceFilePath(name, filePath) {
  sourceFilePath(name, filePath)
}

function sourceFilePath(name, filePath) {
  return resolveContainedPath(sourceDir(name), filePath)
}

export function readBuildLog(name) {
  const logPath = join(projectsDir, name, 'build.log')
  if (!existsSync(logPath)) return null
  return readFileSync(logPath, 'utf8')
}

export async function readBuildLogAsync(name) {
  const logPath = join(projectsDir, name, 'build.log')
  if (!await pathExists(logPath)) return null
  return readFile(logPath, 'utf8')
}

/**
 * Extract pipeline warnings from the build log (non-fatal failures, skipped phases).
 * These are build-runner issues, not LaTeX issues — synctex missing, image patching failed, etc.
 */
export function extractPipelineWarnings(name) {
  const log = readBuildLog(name)
  if (!log) return []
  const warnings = []
  for (const line of log.split('\n')) {
    if (line.includes('(non-fatal)')) {
      warnings.push(line.replace(/^\[[\d\-T:.Z]+\]\s*/, '').trim())
    } else if (line.includes('skipping lookup') || line.includes('No synctex.gz found')) {
      warnings.push(line.replace(/^\[[\d\-T:.Z]+\]\s*/, '').trim())
    } else if (line.includes('BUILD FAILED')) {
      warnings.push(line.replace(/^\[[\d\-T:.Z]+\]\s*/, '').trim())
    } else if (line.includes('pages missing')) {
      warnings.push(line.replace(/^\[[\d\-T:.Z]+\]\s*/, '').trim())
    }
  }
  return warnings
}

export async function extractPipelineWarningsAsync(name) {
  const log = await readBuildLogAsync(name)
  if (!log) return []
  const warnings = []
  for (const line of log.split('\n')) {
    if (line.includes('(non-fatal)')) {
      warnings.push(line.replace(/^\[[\d\-T:.Z]+\]\s*/, '').trim())
    } else if (line.includes('skipping lookup') || line.includes('No synctex.gz found')) {
      warnings.push(line.replace(/^\[[\d\-T:.Z]+\]\s*/, '').trim())
    } else if (line.includes('BUILD FAILED')) {
      warnings.push(line.replace(/^\[[\d\-T:.Z]+\]\s*/, '').trim())
    } else if (line.includes('pages missing')) {
      warnings.push(line.replace(/^\[[\d\-T:.Z]+\]\s*/, '').trim())
    }
  }
  return warnings
}

/**
 * Extract structured errors and warnings from a LaTeX log file.
 * Returns { errors: [{ message, line?, file? }], warnings: string[] }
 */
export async function extractBuildErrors(name) {
  const project = await readProject(name)
  if (!project) return { errors: [], warnings: [] }

  // latex.log is preserved by build-runner after latexmk runs
  const logPath = join(projectsDir, name, 'latex.log')
  const logText = await readTextOrNull(logPath)
  if (logText === null) return { errors: [], warnings: [] }
  const result = parseLatexErrors(logText)

  // Enrich errors with source context (±2 lines around the error)
  const srcDir = join(projectsDir, name, 'source')
  const mainFile = project.mainFile || null
  for (const err of result.errors) {
    if (!err.line) continue
    const file = err.file || mainFile
    if (!file) continue
    const srcPath = join(srcDir, file)
    const sourceText = await readTextOrNull(srcPath)
    if (sourceText === null) continue
    const srcLines = sourceText.split('\n')
    const start = Math.max(0, err.line - 4)   // 3 lines before (0-indexed: line-1 is the error)
    const end = Math.min(srcLines.length, err.line + 3)  // 3 lines after
    err.context = srcLines.slice(start, end).map((text, i) => ({
      line: start + i + 1,
      text,
    }))
    err.errorLine = err.line  // which line in context is the actual error
  }

  return result
}

/**
 * Parse LaTeX log text into structured errors and warnings.
 */
export function parseLatexErrors(logText) {
  const lines = logText.split('\n')
  const errors = []
  const warnings = []

  // Track current file from LaTeX's parenthesis-based file stack.
  // Every ( pushes (filename or null), every ) pops — must stay balanced.
  const fileStack = []  // stack of filenames (or null for non-file parens)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    for (let ci = 0; ci < line.length; ci++) {
      if (line[ci] === '(') {
        const rest = line.slice(ci + 1)
        const fileMatch = rest.match(/^([^\s()]+\.tex)\b/)
        if (fileMatch) {
          fileStack.push(fileMatch[1].replace(/^\.\//, ''))
        } else {
          fileStack.push(null)  // non-file paren — still push to keep stack balanced
        }
      } else if (line[ci] === ')' && fileStack.length > 0) {
        fileStack.pop()
      }
    }

    // Current file = nearest .tex file on the stack
    const currentFile = fileStack.findLast(f => f !== null) ?? null

    // LaTeX errors start with !
    if (line.startsWith('!')) {
      let msg = line
      let errorLine = null
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (lines[j].startsWith('!') || lines[j] === '') break
        msg += '\n' + lines[j]
        // Parse "l.NNN" line reference
        const lMatch = lines[j].match(/^l\.(\d+)\s/)
        if (lMatch) errorLine = parseInt(lMatch[1])
      }
      errors.push({ message: msg, line: errorLine, file: currentFile })
    }

    // Undefined control sequence (sometimes not prefixed with !)
    if (line.includes('Undefined control sequence') && !line.startsWith('!')) {
      // Next line often has l.NNN
      let errorLine = null
      if (i + 1 < lines.length) {
        const lMatch = lines[i + 1].match(/^l\.(\d+)\s/)
        if (lMatch) errorLine = parseInt(lMatch[1])
      }
      errors.push({ message: line.trim(), line: errorLine, file: currentFile })
    }

    // LaTeX warnings (reference/citation only — skip noise)
    // LaTeX hard-wraps at column 80, often mid-word (e.g. "line 1\n25.").
    // Collect continuation lines until a period or blank line, joining without
    // a space when the previous chunk ended mid-token (no trailing space/period).
    if (line.includes('LaTeX Warning:') || /^Package \S+ Warning:/.test(line)) {
      if (/(Reference|references|Citation|citations|undefined|Label\(s\) may have changed|Biber|BibTeX)/i.test(line)) {
        let msg = line
        for (let j = i + 1; j < lines.length; j++) {
          const cont = lines[j]
          if (cont === '' || cont.startsWith('!') || cont.includes('Warning:')) break
          if (/^\([^)]+\)\s+/.test(cont)) {
            msg += '\n' + cont.trimEnd()
            continue
          }
          if (msg.endsWith(' ') || cont.startsWith(' ')) {
            msg += cont.trimStart()
          } else {
            msg += cont.trim()
          }
        }
        msg = msg.trim()
        // Parse into structured warning: { message, line, file }
        const lineMatch = msg.match(/on input line (\d+)/)
        const warnLine = lineMatch ? parseInt(lineMatch[1]) : null
        warnings.push({ message: msg, line: warnLine, file: currentFile })
      }
    }
  }

  // Filter out false positives from draft mode
  const filteredErrors = errors.filter(e =>
    !e.message.includes('Cannot determine size of graphic')
  )

  return { errors: filteredErrors, warnings }
}
