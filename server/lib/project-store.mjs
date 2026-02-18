/**
 * Project metadata storage.
 *
 * Projects live in server/projects/{name}/:
 *   project.json  — metadata (name, title, mainFile, pages, buildStatus, ...)
 *   source/       — uploaded tex/bib/sty/cls files
 *   output/       — build output (SVGs, lookup.json, macros.json, proof-info.json)
 *   build.log     — last build log
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'fs'
import { join, relative } from 'path'
import { createHash } from 'crypto'

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

export function createProject({ name, title, mainFile = 'main.tex', format = 'svg', sourceDir: srcDir }) {
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
    ...(srcDir && { sourceDir: srcDir }),
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
 * Get MD5 hashes of all source files. Returns { "path": "hex", ... }
 */
export function hashSourceFiles(name) {
  const dir = sourceDir(name)
  if (!existsSync(dir)) return {}
  const hashes = {}
  for (const full of walkDir(dir)) {
    const rel = relative(dir, full)
    const ext = '.' + rel.split('.').pop()
    if (BUILD_JUNK.has(ext)) continue
    hashes[rel] = createHash('md5').update(readFileSync(full)).digest('hex')
  }
  return hashes
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

/**
 * Delete a source file. Returns true if the file existed and was removed.
 */
export function deleteSourceFile(name, filePath) {
  const dir = sourceDir(name)
  const full = join(dir, filePath)
  if (!full.startsWith(dir)) throw new Error('Invalid file path')
  if (!existsSync(full)) return false
  unlinkSync(full)
  return true
}

export function readBuildLog(name) {
  const logPath = join(projectsDir, name, 'build.log')
  if (!existsSync(logPath)) return null
  return readFileSync(logPath, 'utf8')
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
    if (line.includes('LaTeX Warning:') || line.includes('Package natbib Warning:')) {
      if (line.includes('Reference') || line.includes('Citation') || line.includes('Label(s) may have changed')) {
        let msg = line
        for (let j = i + 1; j < lines.length; j++) {
          const cont = lines[j]
          if (cont === '' || cont.startsWith('!') || cont.includes('Warning:')) break
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

  return { errors, warnings }
}
