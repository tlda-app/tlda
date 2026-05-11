// Grammar lint for .tex files — non-grammatical commas and colons.
//
// Wraps lint-typography.py, which substitutes math with grammatical
// placeholders (so spaCy can parse prose containing math as normal English),
// then uses spaCy's dependency tree to flag violations.

import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HELPER = join(__dirname, 'lint-typography.py')

function runHelper(filePath) {
  const result = spawnSync('python3', [HELPER, filePath], { encoding: 'utf8' })
  if (result.status !== 0) {
    console.error('[lint-typography] helper failed:', result.stderr || `exit ${result.status}`)
    return []
  }
  try {
    return JSON.parse(result.stdout || '[]')
  } catch (e) {
    console.error('[lint-typography] failed to parse helper output:', e.message)
    return []
  }
}

// Lint a full text. Returns [{file, line, pattern, snippet}].
export function lintText(text, file = '<text>') {
  const dir = mkdtempSync(join(tmpdir(), 'lint-typography-'))
  const tmpFile = join(dir, 'input.tex')
  writeFileSync(tmpFile, text)
  const raw = runHelper(tmpFile)
  return raw.map((f) => ({ ...f, file, pattern: f.kind || 'typography' }))
}

// Parse a unified diff and return only the added lines per file with their
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
    if (hunk) { curLine = parseInt(hunk[1], 10); continue }
    if (l.startsWith('+') && !l.startsWith('+++')) { added.add(curLine); curLine++ }
    else if (l.startsWith('-') && !l.startsWith('---')) { /* no advance */ }
    else if (!l.startsWith('\\')) { curLine++ }
  }
  return out
}

// Lint a unified diff against post-state file contents.
// `readFile(path)` — returns post-state file contents (or null)
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
