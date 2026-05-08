// Parens lint for agent-written prose in .tex files.
// Mirrors ~/work/dot-claude/spellbook/lints/agent-parentheticals/runner/run.mjs
// but as a library: takes text or a unified diff, returns lint findings.

const ENV_BLOCK_NAMES = [
  'equation', 'equation\\*',
  'align', 'align\\*',
  'gather', 'gather\\*',
  'multline', 'multline\\*',
  'displaymath',
  'eqnarray', 'eqnarray\\*',
  'array',
]
const ENV_BEGIN_RE = new RegExp(`\\\\begin\\{(${ENV_BLOCK_NAMES.join('|')})\\}`)
const ENV_END_RE = new RegExp(`\\\\end\\{(${ENV_BLOCK_NAMES.join('|')})\\}`)

function stripInlineMath(line) {
  let s = line
  s = s.replace(/\$\$[^$]*\$\$/g, ' ')
  s = s.replace(/\\\[[^\]]*\\\]/g, ' ')
  s = s.replace(/\$[^$\n]*\$/g, ' ')
  s = s.replace(/\\\([^)]*\\\)/g, ' ')
  return s
}

function stripCrossRefs(line) {
  let s = line
  s = s.replace(/\\(cite[ptes]?|ref|eqref|pageref|cref|Cref|autoref)\{[^}]*\}/g, ' ')
  s = s.replace(
    /\((?:see |cf\. ?|cf\.? ?|c\.f\. ?)?(?:Section|Sec\.?|§|Theorem|Thm\.?|Proposition|Prop\.?|Lemma|Corollary|Cor\.?|Definition|Def\.?|Equation|Eq\.?|Figure|Fig\.?|Table|Tab\.?|Chapter|Ch\.?|Appendix|App\.?) [^)]+\)/g,
    ' '
  )
  return s
}

const PATTERNS = [
  { name: 'mid-sentence-aside', regex: /,\s*\([^()]{8,}\)\s*,/g },
  { name: 'trailing-justification', regex: /\b(?:by|using|since|because|because of|via|under|where|when|with|so that|provided)\b[^.()]*\([^()]{8,}\)\s*\./gi },
  { name: 'substantive-paren', regex: /\([^()]{25,}\)/g },
]

// Lint a full text. Returns [{file, line, pattern, snippet}].
export function lintText(text, file = '<text>') {
  const results = []
  const lines = text.split('\n')
  let inMathEnv = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!inMathEnv && ENV_BEGIN_RE.test(line)) { inMathEnv = true; continue }
    if (inMathEnv) {
      if (ENV_END_RE.test(line)) inMathEnv = false
      continue
    }
    if (line.trim().startsWith('%')) continue
    const stripped = stripCrossRefs(stripInlineMath(line))
    for (const { name, regex } of PATTERNS) {
      regex.lastIndex = 0
      let m
      while ((m = regex.exec(stripped)) !== null) {
        const snippet = m[0].slice(0, 80).replace(/\s+/g, ' ')
        results.push({ file, line: i + 1, pattern: name, snippet })
      }
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
// `diffText` — output of `git diff HEAD~1 HEAD -- "*.tex"` or similar
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
