// Typography lint for .tex files — flags grammatically wrong patterns.
// Currently catches: comma immediately before \qwhere, \qfor, or \qand
// inside display math environments. These macros are conjunctions and
// a preceding comma is always a grammar error.

const ENV_NAMES = [
  'equation', 'equation\\*',
  'align', 'align\\*',
  'gather', 'gather\\*',
  'multline', 'multline\\*',
  'eqnarray', 'eqnarray\\*',
  'flalign', 'flalign\\*',
  'alignat', 'alignat\\*',
  'subequations',
  'cases',
]
const ENV_BEGIN_RE = new RegExp(`\\\\begin\\{(${ENV_NAMES.join('|')})\\}`)
const ENV_END_RE = new RegExp(`\\\\end\\{(${ENV_NAMES.join('|')})\\}`)

// Also treat \[ ... \] as display math.
const DISPLAY_OPEN_RE = /\\\[/
const DISPLAY_CLOSE_RE = /\\\]/

// Comma immediately before \qwhere, \qfor, or \qand (with optional whitespace).
const COMMA_BEFORE_CONJUNCTION_RE = /,\s*\\q(where|for|and)\b/g

function stripComment(line) {
  return line.replace(/(?<!\\)%.*$/, '')
}

// Lint a full text. Returns [{file, line, pattern, snippet}].
export function lintText(text, file = '<text>') {
  const results = []
  const lines = text.split('\n')
  let inDisplay = false
  let bracketDepth = 0 // for \[ ... \]

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = stripComment(raw)

    // Track display math state
    if (!inDisplay) {
      if (ENV_BEGIN_RE.test(line)) { inDisplay = true; continue }
      if (DISPLAY_OPEN_RE.test(line)) { bracketDepth++; inDisplay = true; continue }
      continue
    }

    // Inside display math
    if (ENV_END_RE.test(line)) { inDisplay = false; continue }
    if (DISPLAY_CLOSE_RE.test(line)) {
      bracketDepth = Math.max(0, bracketDepth - 1)
      if (bracketDepth === 0) inDisplay = false
      // still check this line before closing
    }

    COMMA_BEFORE_CONJUNCTION_RE.lastIndex = 0
    let m
    while ((m = COMMA_BEFORE_CONJUNCTION_RE.exec(line)) !== null) {
      const snippet = line.slice(Math.max(0, m.index - 20), m.index + 40).trim()
      results.push({ file, line: i + 1, pattern: 'comma-before-conjunction', snippet })
    }
  }
  return results
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
