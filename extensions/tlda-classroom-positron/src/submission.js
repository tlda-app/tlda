'use strict'
// The same two faults the upload refuses, checked before the student zips.
//
// Deliberately a copy of the rules in server/lib/classroom-submission.mjs rather
// than an import: this runs in Positron's extension host on a student's laptop,
// with no server and no network. The wording is kept identical on purpose — a
// student who sees one message here and a different one at hand-in would think
// they were two different problems.

const PLACEHOLDER = /^\s*\*?\(?your answer here\)?\*?\s*$/i
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)>\s]+)>?[^)]*\)/g
const REMOTE = /^(https?:|data:|mailto:|#)/i

/**
 * The document with code removed, for asking what it *refers to*.
 *
 * An image written inside backticks is being shown to the reader, not included:
 * the week 0 handout tells students to write `![](my-photo.png)`, and reading
 * that as a real reference refuses the hand-in over a photo nobody ever had.
 */
function withoutCode(source) {
  return source
    .replace(/^[ \t]*(```+|~~~+)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '')
}

/** Images the document references, ignoring anything remote. */
function referencedImages(source) {
  const out = []
  for (const match of withoutCode(source).matchAll(MARKDOWN_IMAGE)) {
    const target = decodeURIComponent(match[1].trim())
    if (!REMOTE.test(target)) out.push(target)
  }
  return [...new Set(out)]
}

/**
 * Answers written underneath the box instead of inside it.
 *
 * His documents are narrative sections with several exercises inside each, so a
 * heading is not a problem boundary — the exercise is.
 *
 * **This needs the template the student started from, and without it makes no
 * claim.** Text under an answer block is the document's own narrative far more
 * often than it is a misplaced answer: on his week 0 handout, untouched, four
 * blocks are followed by prose or an `{r}` chunk that he wrote. Guessing from
 * shape alone refuses work that is perfectly fine, and a check that blocks a
 * correct hand-in is worse than the mistake it was meant to catch — a student
 * who cannot submit is stuck, a student with a stray answer loses one mark.
 *
 * Against the template the question is exact: text that is under an unanswered
 * block *and is not in the handout* is text the student typed there.
 */
function strayAnswers(source, template) {
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

/**
 * Problems to fix, as sentences a student can act on. Empty means ready to hand in.
 * `exists` answers whether a referenced file is actually on disk, so this stays
 * free of any filesystem dependency and can be tested directly.
 */
function problems(source, exists, template) {
  const found = []
  for (const image of referencedImages(source)) {
    if (!exists(image)) {
      found.push(`This references an image that is not beside the document: ${image}. Put it in the same folder and check the name matches.`)
    }
  }
  for (const stray of strayAnswers(source, template)) {
    found.push(`Your answer to ${stray.id.replace(/^ans-/, '')} is underneath the answer box rather than inside it, so it would not be marked — "${stray.firstLine}…". Move it between the \`:::\` lines.`)
  }
  return found
}

module.exports = { referencedImages, strayAnswers, problems }
