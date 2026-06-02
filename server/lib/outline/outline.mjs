// Outline parser: a .tex region -> a clause-grain markdown outline that the
// viewer renders. Structural atoms (paragraph labels, display blocks) are kept
// whole; prose runs are clause-split by clause-split.py (spaCy, verbalized
// relations). Macros are kept verbatim; KaTeX-incompatible environments/refs
// are rewritten so the markdown renders.

import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLAUSE_SPLIT = join(HERE, 'clause-split.py')

const viewText = (s) => s.replace(/\s+/g, ' ').trim()

// --- structural atoms ---------------------------------------------------
function findAtomicSpans(text) {
  const spans = []
  const lineRe = /^[ \t]*\\(emph|paragraph|subparagraph|textbf|textit)\{[^\n]*\}[ \t]*$/gm
  let m
  while ((m = lineRe.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length, kind: 'label' })
  const reBracket = /\\\[[\s\S]*?\\\]/g
  while ((m = reBracket.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length, kind: 'display' })
  const reEnv = /\\begin\{(equation\*?|align\*?|aligned|gather\*?|multline\*?)\}[\s\S]*?\\end\{\1\}/g
  while ((m = reEnv.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length, kind: 'display' })
  spans.sort((a, b) => a.start - b.start)
  const out = []
  let lastEnd = -1
  for (const s of spans) if (s.start >= lastEnd) { out.push(s); lastEnd = s.end }
  return out
}

// --- clause split of a prose run via spaCy ------------------------------
function clauseSplit(prose, baseOffset) {
  const dir = mkdtempSync(join(tmpdir(), 'outline-clause-'))
  const f = join(dir, 'run.txt')
  writeFileSync(f, prose)
  const res = spawnSync('python3', [CLAUSE_SPLIT, f], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error('clause-split.py failed: ' + (res.stderr || res.status))
  const spans = JSON.parse(res.stdout || '[]')
  return spans.map(([a, b]) => ({ start: baseOffset + a, end: baseOffset + b, kind: 'clause' }))
}

function parseRegion(text) {
  const atomics = findAtomicSpans(text)
  const rawLeaves = []
  let cursor = 0
  for (const a of atomics) {
    if (a.start > cursor) {
      const prose = text.slice(cursor, a.start)
      if (prose.trim()) for (const cl of clauseSplit(prose, cursor)) rawLeaves.push(cl)
    }
    rawLeaves.push({ start: a.start, end: a.end, kind: a.kind })
    cursor = a.end
  }
  if (cursor < text.length) {
    const prose = text.slice(cursor)
    if (prose.trim()) for (const cl of clauseSplit(prose, cursor)) rawLeaves.push(cl)
  }
  rawLeaves.sort((a, b) => a.start - b.start)
  return rawLeaves.map((lf) => ({
    level: lf.kind === 'label' ? 0 : 1,
    kind: lf.kind,
    text: text.slice(lf.start, lf.end),
  }))
}

// --- render to KaTeX-safe markdown --------------------------------------
function katexSafe(s) {
  return s
    .replace(/\\begin\{equation\*?\}/g, '').replace(/\\end\{equation\*?\}/g, '')
    .replace(/\\begin\{align\*?\}/g, '\\begin{aligned}').replace(/\\end\{align\*?\}/g, '\\end{aligned}')
    .replace(/\\begin\{proof\}(\[[^\]]*\])?/g, '').replace(/\\end\{proof\}/g, '')
    .replace(/\\label\{[^}]*\}/g, '')
    .replace(/~?\\(eqref|Cref|cref|ref|autoref)\{([^}]*)\}/g, ' @$2')
}

export function outlineForRegion(text) {
  const leaves = parseRegion(text)
  const lines = []
  for (const lf of leaves) {
    const indent = '  '.repeat(lf.level)
    if (lf.kind === 'display') {
      const inner = lf.text.replace(/^\s*\\\[/, '').replace(/\\\]\s*$/, '').trim()
      lines.push(`${indent}- $$${katexSafe(inner)}$$`)
    } else if (lf.kind === 'label') {
      const inner = lf.text.replace(/^\\(emph|paragraph|subparagraph|textbf|textit)\{/, '').replace(/\}\s*$/, '')
      lines.push(`${indent}- **${katexSafe(viewText(inner))}**`)
    } else {
      lines.push(`${indent}- ${katexSafe(viewText(lf.text))}`)
    }
  }
  return lines.join('\n') + '\n'
}
