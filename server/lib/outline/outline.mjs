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
  // A header is a \textbf/\textit/\emph/\paragraph that STARTS a line — whether
  // or not prose follows on the same line ("\textit{Step A1: …} By Lemma …").
  // Only the command itself is the atomic; trailing prose stays a normal clause.
  const leadRe = /^([ \t]*)(\\(?:textbf|textit|emph|paragraph|subparagraph)\{[^{}]*\})/gm
  let m
  while ((m = leadRe.exec(text))) {
    const start = m.index + m[1].length
    spans.push({ start, end: start + m[2].length, kind: 'label' })
  }
  const reBracket = /\\\[[\s\S]*?\\\]/g
  while ((m = reBracket.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length, kind: 'display' })
  // Literal $$...$$ display blocks. Must be detected as one atomic, otherwise
  // the bare $$ delimiter lines get swept into adjacent prose runs and emitted
  // as stray lone $$ that break the markdown's $$-pairing on the client.
  const reDD = /\$\$[\s\S]*?\$\$/g
  while ((m = reDD.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length, kind: 'display' })
  const reEnv = /\\begin\{(equation\*?|align\*?|aligned|gather\*?|multline\*?)\}[\s\S]*?\\end\{\1\}/g
  while ((m = reEnv.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length, kind: 'display' })
  spans.sort((a, b) => a.start - b.start)
  const out = []
  let lastEnd = -1
  for (const s of spans) if (s.start >= lastEnd) { out.push(s); lastEnd = s.end }
  return out
}

// --- clause split of a prose run via spaCy ------------------------------
// Returns sentences, each a list of clause leaves: [[{start,end},…], …].
// The grouping is what lets the outline nest clause-under-sentence.
function clauseSplit(prose, baseOffset) {
  const dir = mkdtempSync(join(tmpdir(), 'outline-clause-'))
  const f = join(dir, 'run.txt')
  writeFileSync(f, prose)
  const res = spawnSync('python3', [CLAUSE_SPLIT, f], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error('clause-split.py failed: ' + (res.stderr || res.status))
  const sents = JSON.parse(res.stdout || '[]')
  return sents.map((clauses) =>
    clauses.map(([a, b]) => ({ start: baseOffset + a, end: baseOffset + b })))
}

// Number of enumerate/itemize environments open at a character position —
// this is the nesting depth that gives the outline its structure.
function listDepthAt(text, pos) {
  let depth = 0
  const re = /\\(begin|end)\{(enumerate|itemize|description)\}/g
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index >= pos) break
    depth += m[1] === 'begin' ? 1 : -1
  }
  return Math.max(0, depth)
}

// Sectioning rank of a header: lower = higher in the hierarchy. Drives how deep
// the content beneath a header indents (content base = rank + 1).
function headerRank(raw) {
  if (/\\subsubsection/.test(raw)) return 2
  if (/\\subsection/.test(raw)) return 1
  if (/\\section/.test(raw)) return 0
  if (/\\(sub)?paragraph/.test(raw)) return 3
  const inner = raw.replace(/^\\[a-z]+\*?\{/i, '')
  if (/^\s*Part\b/i.test(inner)) return 0
  if (/^\s*(Step|Case|Claim|Lemma|Sub-?case)\b/i.test(inner)) return 1
  return 1 // generic bold/italic header acts as a sub-section
}

// The structural parse — the single source of truth for outline depth.
// Returns ORDERED, NON-OVERLAPPING leaf spans covering the structural atoms and
// clauses of `text`: `[{start, end, level, kind, body}]`. Every character is
// either inside a leaf span or inside a joiner gap between leaves — so a
// round-trip layer can reconstruct the region from (head + Σ slice + joiner).
//   - start/end : verbatim offsets into `text` (text.slice(start,end) is the token)
//   - level     : nesting depth (section→Step→sentence→clause→display + lists)
//   - kind      : 'label' | 'clause' | 'display'
//   - body      : the rendered/KaTeX-safe display string (note + .md show this)
// Empty-after-cleaning leaves are dropped (their text falls into a joiner gap).
export function structuralLeaves(text) {
  const atomics = findAtomicSpans(text)
  const leaves = []
  let cursor = 0
  let headerBase = 1   // indent level for a sentence's first clause
  let lastLevel = 0    // level of the previous leaf — displays nest one deeper

  const emitProse = (start, end) => {
    const prose = text.slice(start, end)
    if (!prose.trim()) return
    for (const clauses of clauseSplit(prose, start)) {
      clauses.forEach((cl, i) => {
        const body = cleanInline(katexSafe(viewText(text.slice(cl.start, cl.end))))
        if (!body) return
        // first clause of a sentence sits at the section base; the rest of the
        // sentence's clauses nest one level under it.
        const level = headerBase + listDepthAt(text, cl.start) + (i === 0 ? 0 : 1)
        leaves.push({ start: cl.start, end: cl.end, level, kind: 'clause', body })
        lastLevel = level
      })
    }
  }

  for (const a of atomics) {
    if (a.start > cursor) emitProse(cursor, a.start)
    const raw = text.slice(a.start, a.end)
    if (a.kind === 'label') {
      const rank = headerRank(raw)
      headerBase = rank + 1
      const inner = raw.replace(/^\\[a-z]+\*?\{/i, '').replace(/\}\s*$/, '')
      leaves.push({ start: a.start, end: a.end, level: rank, kind: 'label', body: `**${katexSafe(viewText(inner))}**` })
      lastLevel = rank
    } else { // display — nest under the introducing clause
      const inner = raw
        .replace(/^\s*\$\$/, '').replace(/\$\$\s*$/, '')
        .replace(/^\s*\\\[/, '').replace(/\\\]\s*$/, '')
        .trim()
      if (inner) {
        const level = Math.max(headerBase + listDepthAt(text, a.start), lastLevel + 1)
        leaves.push({ start: a.start, end: a.end, level, kind: 'display', body: `$$${katexSafe(inner)}$$` })
        lastLevel = level
      }
    }
    cursor = a.end
  }
  if (cursor < text.length) emitProse(cursor, text.length)
  return leaves
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

// Clean LaTeX list/structure control out of a prose clause and turn text-mode
// formatting into markdown so it renders instead of leaking as raw `\item`/
// `\textit{…}`. Nesting is conveyed by indent (see listDepthAt), so the list
// environment + item markers themselves are dropped.
function cleanInline(s) {
  return s
    .replace(/\\(begin|end)\{(enumerate|itemize|description)\}/g, '')
    .replace(/\\item\b\s*(\[[^\]]*\])?/g, '')
    .replace(/\\textbf\{([^{}]*)\}/g, '**$1**')
    .replace(/\\(textit|emph|textsl)\{([^{}]*)\}/g, '*$2*')
    .replace(/%+\s*$/, '')
    .trim()
}

// Slice a word-precise region out of a source file given a (line,col) span.
// Positions are 1-indexed lines, 0-indexed columns. The span is collapsed to
// whole words: if an endpoint falls inside a word, it extends outward to the
// nearest word boundary so we never cut a word in half. Lines are only an
// internal coordinate — the result is the exact continuous substring from the
// first selected word to the last.
export function regionFromSpan(text, startLine, startCol, endLine, endCol) {
  const lines = text.split('\n')
  const offsetOf = (ln, col) => {
    let off = 0
    for (let i = 0; i < ln - 1 && i < lines.length; i++) off += lines[i].length + 1
    return off + col
  }
  let s = offsetOf(startLine, startCol)
  let e = offsetOf(endLine, endCol)
  if (e < s) { const t = s; s = e; e = t }
  s = Math.max(0, Math.min(s, text.length))
  e = Math.max(0, Math.min(e, text.length))
  const isWord = (c) => c != null && /\w/.test(c)
  while (s > 0 && isWord(text[s - 1]) && isWord(text[s])) s--
  while (e < text.length && isWord(text[e - 1]) && isWord(text[e])) e++
  return text.slice(s, e)
}

export function outlineForRegion(text) {
  // The clean human/.md render: indent by level, show the rendered body.
  return structuralLeaves(text)
    .map((lf) => `${'  '.repeat(lf.level)}- ${lf.body}`)
    .join('\n') + '\n'
}
