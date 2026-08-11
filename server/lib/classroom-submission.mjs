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
// Answer blocks carry the exercise id that problem-by-problem marking groups by.
const ANSWER_ID = /:::\s*\{[^}]*#(ans-[A-Za-z0-9_-]+)[^}]*\}/g
const REMOTE = /^(https?:|data:|mailto:|#)/i
// What a blanked answer block holds before anyone types in it, from his own
// bin/make-handout.py.
const PLACEHOLDER = /^\s*\*?\(?your answer here\)?\*?\s*$/i

function isUnsafeEntry(name) {
  if (path.isAbsolute(name) || /^[A-Za-z]:/.test(name)) return true
  return name.split('/').includes('..')
}

/**
 * Answers written underneath the box instead of inside it.
 *
 * Skip's documents are narrative sections with exercises inside them, so a
 * heading is not a problem boundary — the exercise is. A student who types
 * under the closing fence gets a perfect preview and an empty extraction, and
 * Quarto reports nothing: it is valid markup, just not an answer.
 *
 * The signal needs no copy of the template: an answer block still holding only
 * its placeholder, with prose sitting between its close and the next fence or
 * heading, is someone who wrote in the wrong place. An untouched block with
 * nothing after it is simply a problem they skipped, which is allowed.
 */
export function strayAnswers(source) {
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
    const stray = after.filter(line => line.trim())
    if (!answered && stray.length) found.push({ id: open[1], firstLine: stray[0].trim().slice(0, 60) })
    i = j + 1
  }
  return found
}

export function parseQmdReferences(source) {
  const images = []
  for (const match of source.matchAll(MARKDOWN_IMAGE)) {
    const target = decodeURIComponent(match[1].trim())
    if (!REMOTE.test(target)) images.push(target)
  }
  const answerIds = [...source.matchAll(ANSWER_ID)].map(match => match[1])
  return { images, answerIds }
}

/**
 * Read an uploaded archive and decide whether it can be marked.
 *
 * Returns { ok, errors, qmdPath, answerIds, files }. `errors` holds plain
 * sentences naming what to fix, because that list is what the student reads.
 * A bad archive is a reported error, never a thrown one.
 */
export function inspectSubmissionArchive(bytes) {
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
  if (qmds.length > 1) errors.push(`The archive has ${qmds.length} .qmd files (${qmds.join(', ')}). It should hold exactly one.`)
  if (qmds.length !== 1) return { ok: false, errors, qmdPath: null, answerIds: [], files: names }

  const qmdPath = qmds[0]
  const { images, answerIds } = parseQmdReferences(strFromU8(unpacked[qmdPath]))

  // Image targets are written relative to the .qmd, which is how the student
  // sees them in their own editor.
  const base = path.posix.dirname(qmdPath)
  const present = new Set(names)
  const missing = [...new Set(images.filter(target => {
    const resolved = path.posix.normalize(base === '.' ? target : `${base}/${target}`)
    return !present.has(resolved)
  }))]

  if (missing.length) {
    errors.push(`${qmdPath} references ${missing.length === 1 ? 'an image that is not' : 'images that are not'} in the archive: ${missing.join(', ')}. Add ${missing.length === 1 ? 'it' : 'them'} next to the .qmd and zip it again.`)
  }
  for (const stray of strayAnswers(strFromU8(unpacked[qmdPath]))) {
    errors.push(`Your answer to ${stray.id.replace(/^ans-/, '')} is underneath the answer box rather than inside it, so it would not be marked — "${stray.firstLine}…". Move it between the \`:::\` lines.`)
  }
  if (answerIds.length === 0) {
    errors.push(`${qmdPath} has no answer blocks. Write your answers inside the blanked solution callouts from the template rather than replacing them.`)
  }

  // `entries` rides along so accepting a submission does not unzip a second
  // time — and so the bytes that were validated are the bytes that get stored.
  return { ok: errors.length === 0, errors, qmdPath, answerIds, files: names, entries: unpacked }
}
