import { unzipSync, strFromU8 } from 'fflate'
import path from 'node:path'

// A submission is an archive, not a file: students get a template whose solution
// callouts are blanked, answer inside them, and photograph anything they did on
// paper — so the .qmd travels with the images it references.
//
// Everything here exists to tell a student what is wrong with their archive
// while they are still standing there to fix it. A missing photo discovered at
// marking time reads as an unanswered question.

const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/
// Markdown images: ![alt](target "title"). The target stops at whitespace or ).
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)>\s]+)>?[^)]*\)/g
const QUARTO_INCLUDE = /\{\{<\s*include\s+(?:"([^"]+)"|'([^']+)'|([^\s>]+))\s*>\}\}/g
// Answer blocks carry the exercise id that problem-by-problem marking groups by.
const ANSWER_ID = /:::\s*\{[^}]*#(ans-[A-Za-z0-9_-]+)[^}]*\}/g
const REMOTE = /^(https?:|data:|mailto:|#)/i
// What a blanked answer block holds before anyone types in it, from his own
// bin/make-handout.py.
const PLACEHOLDER = /^\s*\*?\(?your answer here\)?\*?\s*$/i

/**
 * Answers written underneath the box instead of inside it.
 *
 * A student who types under the closing fence gets a perfect preview and an
 * empty extraction, and Quarto reports nothing: it is valid markup, just not an
 * answer. His documents are narrative sections with several exercises inside
 * each, so a heading is not a problem boundary — the exercise is.
 *
 * **It needs the template the student started from, and without one it makes no
 * claim.** An earlier version guessed from shape alone — an unanswered block
 * with prose under it — and on his week 0 handout, untouched, it refused four
 * blocks: the prose and `{r}` chunks under them are his own narrative. Nothing
 * about their shape distinguishes them from a misplaced answer, because there is
 * nothing to distinguish. **Refusing a correct hand-in is the worse failure** —
 * a stray answer costs a mark, while a student who cannot submit is stuck before
 * a deadline, told to move text that is not theirs.
 *
 * Against the template it is exact rather than heuristic: text under an
 * unanswered block that is not in the handout is text the student put there.
 */
export function strayAnswers(source, template) {
  if (!template) return []
  const templateLines = new Set(template.split('\n').map(line => line.trim()).filter(Boolean))
  const lines = source.split('\n')
  const found = []
  let i = 0
  while (i < lines.length) {
    const open = lines[i].match(/^:::+\s*\{[^}]*#(ans-[A-Za-z0-9_-]+)[^}]*\}/)
    if (!open) { i++; continue }
    let j = i + 1
    const body = []
    while (j < lines.length && !/^:::+\s*$/.test(lines[j])) { body.push(lines[j]); j++ }
    const answered = body.some(line => line.trim() && !PLACEHOLDER.test(line))
    let k = j + 1
    const after = []
    while (k < lines.length && !/^:::+/.test(lines[k]) && !/^#{1,6}\s/.test(lines[k])) { after.push(lines[k]); k++ }
    const stray = after.map(line => line.trim()).filter(line => line && !templateLines.has(line))
    if (!answered && stray.length) found.push({ id: open[1], firstLine: stray[0].slice(0, 60) })
    i = j + 1
  }
  return found
}

function isUnsafeEntry(name) {
  if (path.isAbsolute(name) || /^[A-Za-z]:/.test(name)) return true
  return name.split('/').includes('..')
}

/**
 * The document with code removed, for asking what it *refers to*.
 *
 * An image written inside backticks is being shown to the reader, not included:
 * his week 0 handout tells students to write `![](my-photo.png)`, and reading
 * that as a real reference refuses every hand-in for that assignment over a
 * photo nobody ever had. Fenced blocks go too — an `{r}` chunk that prints
 * markdown is the same situation.
 */
function withoutCode(source) {
  return source
    .replace(/^[ \t]*(```+|~~~+)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '')
}

export function parseQmdReferences(source) {
  const images = []
  const includes = []
  const prose = withoutCode(source)
  for (const match of prose.matchAll(MARKDOWN_IMAGE)) {
    const target = decodeURIComponent(match[1].trim())
    if (!REMOTE.test(target)) images.push(target)
  }
  for (const match of prose.matchAll(QUARTO_INCLUDE)) {
    const target = decodeURIComponent((match[1] || match[2] || match[3]).trim())
    if (!REMOTE.test(target)) includes.push(target)
  }
  const answerIds = [...source.matchAll(ANSWER_ID)].map(match => match[1])
  return { images, includes, answerIds }
}

/**
 * Read an uploaded archive and decide whether it can be marked.
 *
 * Returns { ok, errors, qmdPath, answerIds, files }. `errors` holds plain
 * sentences naming what to fix, because that list is what the student reads.
 * A bad archive is a reported error, never a thrown one.
 */
export function inspectSubmissionArchive(bytes, { template = null } = {}) {
  const errors = []
  let unpacked
  try {
    unpacked = unzipSync(new Uint8Array(bytes))
  } catch (error) {
    // Fallback path: the student gets a sentence they can act on. The underlying
    // reason still reaches the log, so a real fault (truncated upload, out of
    // memory) is not silently reported to them as a malformed archive.
    console.error('[classroom] could not read submission archive:', error)
    return { ok: false, errors: ['This file is not a readable zip archive.'], qmdPath: null, answerIds: [], files: [] }
  }

  const unsafe = Object.keys(unpacked).filter(isUnsafeEntry)
  if (unsafe.length) {
    return { ok: false, errors: [`The archive contains unsafe paths: ${unsafe.join(', ')}.`], qmdPath: null, answerIds: [], files: [] }
  }

  const names = Object.keys(unpacked).filter(name => !JUNK.test(name) && !name.endsWith('/'))
  const qmds = names.filter(name => name.toLowerCase().endsWith('.qmd'))

  if (qmds.length === 0) errors.push('The archive has no .qmd file. Upload the assignment document you filled in, with any images alongside it.')
  if (qmds.length === 0) return { ok: false, errors, qmdPath: null, answerIds: [], files: names }

  const answerFiles = qmds.map(name => ({ name, ...parseQmdReferences(strFromU8(unpacked[name])) }))
    .filter(file => file.answerIds.length > 0)
  if (answerFiles.length !== 1) {
    errors.push(answerFiles.length === 0
      ? 'The archive has no QMD with answer blocks. Upload the assignment document you filled in.'
      : `The archive has answer blocks in ${answerFiles.length} QMD files (${answerFiles.map(file => file.name).join(', ')}). It should hold one assignment QMD plus any included QMD files.`)
    return { ok: false, errors, qmdPath: null, answerIds: [], files: names }
  }

  const qmdPath = answerFiles[0].name
  const answerIds = answerFiles[0].answerIds

  // Image targets are written relative to the .qmd, which is how the student
  // sees them in their own editor.
  const present = new Set(names)
  const missing = []
  const pending = [qmdPath]
  const checked = new Set()
  while (pending.length) {
    const current = pending.shift()
    if (checked.has(current)) continue
    checked.add(current)
    const base = path.posix.dirname(current)
    const { images, includes } = parseQmdReferences(strFromU8(unpacked[current]))
    for (const target of [...new Set([...images, ...includes])]) {
      const resolved = path.posix.normalize(base === '.' ? target : `${base}/${target}`)
      if (!present.has(resolved)) {
        missing.push(target)
      } else if (includes.includes(target) && resolved.toLowerCase().endsWith('.qmd')) {
        pending.push(resolved)
      }
    }
  }

  if (missing.length) {
    errors.push(`${qmdPath} references ${missing.length === 1 ? 'a file that is not' : 'files that are not'} in the archive: ${[...new Set(missing)].join(', ')}. Add ${missing.length === 1 ? 'it' : 'them'} next to the .qmd and zip it again.`)
  }
  for (const stray of strayAnswers(strFromU8(unpacked[qmdPath]), template)) {
    errors.push(`Your answer to ${stray.id.replace(/^ans-/, '')} is underneath the answer box rather than inside it, so it would not be marked — "${stray.firstLine}…". Move it between the \`:::\` lines.`)
  }
  if (answerIds.length === 0) {
    errors.push(`${qmdPath} has no answer blocks. Write your answers inside the blanked solution callouts from the template rather than replacing them.`)
  }

  // `entries` rides along so accepting a submission does not unzip a second
  // time — and so the bytes that were validated are the bytes that get stored.
  return { ok: errors.length === 0, errors, qmdPath, answerIds, files: names, entries: unpacked }
}
