// Passive-voice lint for agent-written prose in .tex files.
//
// Wraps a Python helper (lint-passive.py) that uses spaCy dependency
// parsing — auxpass/nsubjpass relations — to detect passive constructions
// with high accuracy. Math environments and inline math are stripped before
// parsing so equations don't trip the parser.

import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HELPER = join(__dirname, 'lint-passive.py')

// Run the Python helper on a single file's contents. Returns the parsed
// findings array, or [] on any error (logged).
function runHelper(filePath) {
  const result = spawnSync('python3', [HELPER, filePath], { encoding: 'utf8' })
  if (result.status !== 0) {
    console.error('[lint-passive] helper failed:', result.stderr || `exit ${result.status}`)
    return []
  }
  try {
    return JSON.parse(result.stdout || '[]')
  } catch (e) {
    console.error('[lint-passive] failed to parse helper output:', e.message)
    return []
  }
}

// Lint a full text. Writes to a temp file (the helper takes a path so it
// can preserve line numbers cleanly) and runs the Python helper.
export function lintText(text, file = '<text>') {
  const dir = mkdtempSync(join(tmpdir(), 'lint-passive-'))
  const tmpFile = join(dir, 'input.tex')
  writeFileSync(tmpFile, text)
  const raw = runHelper(tmpFile)
  // Re-label findings with the caller-provided file label, since the helper
  // gets the temp path.
  return raw.map((f) => ({ ...f, file, pattern: f.kind || 'passive' }))
}

// Parse a unified diff and return only added lines per file with their
// new-file line numbers. Returns Map<file, Set<lineNumber>>.
function parseDiffAddedLines(diffText) {
  const out = new Map()
  let curFile = null
  let curLine = 0
  let added
  for (const l of diffText.split('\n')) {
    const fileMatch = l.match(/^\+\+\+ (?:b\/)?(.+)$/)
    if (fileMatch) {
      curFile = fileMatch[1]
      added = new Set()
      out.set(curFile, added)
      continue
    }
    if (!added) continue
    const hunk = l.match(/^@@ [^+]*\+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      curLine = parseInt(hunk[1], 10)
      continue
    }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      added.add(curLine)
      curLine++
    } else if (l.startsWith('-') && !l.startsWith('---')) {
      // doesn't advance new-file line
    } else if (!l.startsWith('\\')) {
      curLine++
    }
  }
  return out
}

// Lint a unified diff against the post-state file contents.
// `diffText` — output of `git diff` or similar
// `readFile(path)` — function returning post-state file contents (or null)
// Returns flat array of lint results with file/line/pattern/snippet.
export function lintDiff(diffText, readFile) {
  const addedByFile = parseDiffAddedLines(diffText)
  const results = []
  for (const [file, addedLines] of addedByFile.entries()) {
    if (!file.endsWith('.tex')) continue
    let content
    try { content = readFile(file) } catch { content = null }
    if (!content) continue
    const allFindings = lintText(content, file)
    for (const finding of allFindings) {
      if (addedLines.has(finding.line)) results.push(finding)
    }
  }
  return results
}
