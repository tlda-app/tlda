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
import { join, relative, dirname } from 'path'
import { createHash, randomUUID } from 'crypto'
import { isSourceFilePath, isIgnoredSourceDir, normalizeSourceManifest, sourceManifestContext } from '../../shared/source-manifest.mjs'
import {
  projectPartsManifestPath as partsManifestPathForRoot,
  readProjectPartsManifest as readPartsManifestForRoot,
  recoverProjectPartsManifest as recoverPartsManifestForRoot,
  writeProjectPartsManifest as writePartsManifestForRoot,
} from './project-parts-scanner.mjs'
import { resolveContainedPath } from './path-containment.mjs'

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

// Reject sourceDirs that would cause runaway file watching: the tlda repo
// itself, the fleet repo, or any other repo containing CLAUDE.md + a busy
// .git directory. The watcher would fire on every git index update, build
// artifact, or scratch file edit and rebuild every project pointed at it
// in a tight loop. (Lost a day to this on 2026-04-10.)

export function createProject({ name, title, mainFile = 'main.tex', format = 'svg', sourceDir: srcDir, members }) {
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
    ...(srcDir && { sourceDir: srcDir }),
    ...(isBook && members && { members }),
    pages: 0,
    createdAt: new Date().toISOString(),
    lastBuild: null,
    buildStatus: isBook ? 'success' : 'none',  // books don't need builds
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

export function beginProjectSourceTransaction(name, { originalLocalHead = null, failJournalWrite = false, durabilityProbe = null } = {}) {
  const dir = projectDir(name)
  const id = randomUUID()
  const transactionRoot = join(dir, '.source-transactions')
  const snapshotRoot = join(transactionRoot, id)
  mkdirSync(snapshotRoot, { recursive: true })
  const source = sourceDir(name)
  const metadata = join(dir, 'project.json')
  const clone = join(dir, 'overleaf-clone')
  if (existsSync(source)) cpSync(source, join(snapshotRoot, 'source'), { recursive: true, preserveTimestamps: true })
  cpSync(metadata, join(snapshotRoot, 'project.json'), { preserveTimestamps: true })
  if (existsSync(clone)) {
    const cloneSnapshot = join(snapshotRoot, 'overleaf-worktree')
    mkdirSync(cloneSnapshot, { recursive: true })
    for (const entry of readdirSync(clone, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      cpSync(join(clone, entry.name), join(cloneSnapshot, entry.name), { recursive: true, preserveTimestamps: true })
    }
  }
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
    rollback() {
      if (finished) throw new Error('Source transaction already finished')
      rmSync(source, { recursive: true, force: true })
      if (existsSync(join(snapshotRoot, 'source'))) cpSync(join(snapshotRoot, 'source'), source, { recursive: true, preserveTimestamps: true })
      const metadataRestore = join(dir, `.project.json.rollback-${process.pid}-${Date.now()}`)
      cpSync(join(snapshotRoot, 'project.json'), metadataRestore, { preserveTimestamps: true })
      renameSync(metadataRestore, metadata)
      restoreCloneWorktree(clone, join(snapshotRoot, 'overleaf-worktree'))
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

export function rollbackProjectSourceRecovery(name, id) {
  const dir = projectDir(name)
  const snapshotRoot = join(dir, '.source-transactions', id)
  const source = sourceDir(name)
  const metadata = join(dir, 'project.json')
  rmSync(source, { recursive: true, force: true })
  if (existsSync(join(snapshotRoot, 'source'))) cpSync(join(snapshotRoot, 'source'), source, { recursive: true, preserveTimestamps: true })
  const metadataRestore = join(dir, `.project.json.rollback-${process.pid}-${Date.now()}`)
  cpSync(join(snapshotRoot, 'project.json'), metadataRestore, { preserveTimestamps: true })
  renameSync(metadataRestore, metadata)
  restoreCloneWorktree(join(dir, 'overleaf-clone'), join(snapshotRoot, 'overleaf-worktree'))
}

export function removeProjectSourceRecovery(name, id) {
  rmSync(join(projectDir(name), '.source-transactions', id), { recursive: true })
}

/**
 * Add a member to a book project, creating the book if it doesn't exist.
 * Deduplicates members. Returns the updated project.
 */
export function addBookMember(bookName, memberName) {
  let book = readProject(bookName)
  if (!book) {
    book = createProject({ name: bookName, title: bookName, format: 'book', members: [memberName] })
  } else {
    const members = Array.from(new Set([...(book.members || []), memberName]))
    book = updateProject(bookName, { members })
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

export function projectPartsRoot(name) {
  return sourceDir(name)
}

export function projectPartsManifestPath(name) {
  return partsManifestPathForRoot(projectPartsRoot(name))
}

export function readProjectPartsManifest(name) {
  if (!readProject(name)) throw new Error(`Project "${name}" not found`)
  return readPartsManifestForRoot(projectPartsRoot(name))
}

export function writeProjectPartsManifest(name, manifest) {
  if (!readProject(name)) throw new Error(`Project "${name}" not found`)
  return writePartsManifestForRoot(projectPartsRoot(name), manifest)
}

export function recoverProjectPartsManifest(name, options = {}) {
  if (!readProject(name)) throw new Error(`Project "${name}" not found`)
  return recoverPartsManifestForRoot(projectPartsRoot(name), options)
}

export function listSourceFiles(name) {
  const dir = sourceDir(name)
  if (!existsSync(dir)) return []
  const project = readProject(name)
  const context = sourceManifestContext(project || {})
  const owned = clientOwnedSourceSet(project)
  return walkDir(dir)
    .map(f => relative(dir, f))
    .filter(f => isClientSourcePath(f, context, owned))
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
export function hashSourceFiles(name) {
  const dir = sourceDir(name)
  if (!existsSync(dir)) return {}
  const project = readProject(name)
  const context = sourceManifestContext(project || {})
  const owned = clientOwnedSourceSet(project)
  const hashes = {}
  for (const full of walkDir(dir)) {
    const rel = relative(dir, full)
    if (!isClientSourcePath(rel, context, owned)) continue
    hashes[rel] = createHash('md5').update(readFileSync(full)).digest('hex')
  }
  return hashes
}

function clientOwnedSourceSet(project) {
  const manifest = project?.clientSourceManifest
  if (!Array.isArray(manifest)) return new Set()
  return new Set(manifest.filter(p => typeof p === 'string'))
}

// Client-owned means authored source supplied by an external authoring ingress
// (CLI push, daemon watcher, Overleaf sync). Server-generated and server-seeded
// files stay outside this manifest and cannot be explicit client deletions.
function isClientSourcePath(rel, context, owned) {
  if (!isSourceFilePath(rel, context)) return false
  return owned.has(rel)
}

export function isClientOwnedSourcePath(name, filePath) {
  const project = readProject(name)
  const owned = clientOwnedSourceSet(project)
  return !!owned && owned.has(filePath)
}

export function readClientSourceManifest(name) {
  const project = readProject(name)
  if (!project) throw new Error(`Project "${name}" not found`)
  return [...clientOwnedSourceSet(project)].sort()
}

export function updateClientSourceManifest(name, sourceManifest) {
  const project = readProject(name)
  if (!project) throw new Error(`Project "${name}" not found`)
  const context = sourceManifestContext(project)
  updateProject(name, { clientSourceManifest: normalizeSourceManifest(sourceManifest, context) })
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

/**
 * Delete a source file. Returns true if the file existed and was removed.
 */
export function deleteSourceFile(name, filePath) {
  const full = sourceFilePath(name, filePath)
  if (!existsSync(full)) return false
  unlinkSync(full)
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

/**
 * Extract structured errors and warnings from a LaTeX log file.
 * Returns { errors: [{ message, line?, file? }], warnings: string[] }
 */
export function extractBuildErrors(name) {
  const project = readProject(name)
  if (!project) return { errors: [], warnings: [] }

  // latex.log is preserved by build-runner after latexmk runs
  const logPath = join(projectsDir, name, 'latex.log')
  if (!existsSync(logPath)) return { errors: [], warnings: [] }

  const logText = readFileSync(logPath, 'utf8')
  const result = parseLatexErrors(logText)

  // Enrich errors with source context (±2 lines around the error)
  const srcDir = join(projectsDir, name, 'source')
  const mainFile = project.mainFile || null
  for (const err of result.errors) {
    if (!err.line) continue
    const file = err.file || mainFile
    if (!file) continue
    const srcPath = join(srcDir, file)
    if (!existsSync(srcPath)) continue
    try {
      const srcLines = readFileSync(srcPath, 'utf8').split('\n')
      const start = Math.max(0, err.line - 4)   // 3 lines before (0-indexed: line-1 is the error)
      const end = Math.min(srcLines.length, err.line + 3)  // 3 lines after
      err.context = srcLines.slice(start, end).map((text, i) => ({
        line: start + i + 1,
        text,
      }))
      err.errorLine = err.line  // which line in context is the actual error
    } catch {}
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
