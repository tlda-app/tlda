import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { strayAnswers } from '../server/lib/classroom-submission.mjs'

const COURSE = fileURLToPath(new URL('./fixtures/classroom-course', import.meta.url))

/**
 * `strayAnswers` decides whether text under an unanswered answer box is the
 * student's or the document's own narrative, by asking whether the line appears
 * in the frozen template. That question only has a right answer when the template
 * is the same KIND of document as the submission.
 *
 * The rows below are the ones marking-release-opus measured against the real
 * QTM285 assignment on 2026-09-10: master QMD accepts, handout QMD accepts, the
 * rendered HTML that `classroom setup` used to freeze refuses. This runs them on
 * the repository fixture so the check travels with the tree.
 */
function generatedHandout() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-stray-'))
  for (const relativePath of ['bin/make-handout.py', 'homework/hw1.qmd', 'homework/shared-preamble.qmd']) {
    fs.mkdirSync(path.join(work, path.dirname(relativePath)), { recursive: true })
    fs.copyFileSync(path.join(COURSE, relativePath), path.join(work, relativePath))
  }
  execFileSync('python3', ['bin/make-handout.py', 'homework/hw1.qmd', 'homework/hw1.handout.qmd'], { cwd: work })
  const handout = fs.readFileSync(path.join(work, 'homework/hw1.handout.qmd'), 'utf8')
  fs.rmSync(work, { recursive: true, force: true })
  return handout
}

/**
 * Stand in for the rendered handout. Any rendered artifact exercises the
 * mechanism under test — an HTML line set against a QMD line set — and wrapping
 * the prose is what a render does to it. Rendering the fixture for real would
 * need Quarto, which is minutes and a machine dependency this check does not want.
 */
function asRenderedHtml(qmd) {
  const body = qmd.split('\n').map(line => (line.trim() ? `<p>${line.trim()}</p>` : '')).join('\n')
  return `<!doctype html>\n<html><body>\n${body}\n</body></html>\n`
}

test('the frozen template must be the homework source, not a render of it', () => {
  const master = fs.readFileSync(path.join(COURSE, 'homework/hw1.qmd'), 'utf8')
  const handout = generatedHandout()

  // A student who hands in the handout with a box still empty, the document's
  // own narrative sitting under it. Nothing here is the student's text.
  const submission = handout
  assert.match(submission, /\{#ans-sum[^}]*\}\n\n:::/, 'the fixture handout must carry an empty answer box')
  assert.match(submission, /Pairing the ends is worth remembering/, 'and narrative after it, or nothing can be stray')

  // What setup freezes now: the master. Every line the handout has, the master
  // has, because the generator changes only solution and starter blocks.
  assert.deepEqual(strayAnswers(submission, master), [], 'the master QMD must accept a correct hand-in')

  // The ideal template, for comparison: the handout itself.
  assert.deepEqual(strayAnswers(submission, handout), [], 'the handout QMD must accept it too')

  // What setup used to freeze. This row is the positive control: without it a
  // green test would prove only that the instrument cannot fire.
  const stray = strayAnswers(submission, asRenderedHtml(handout))
  assert.equal(stray.length, 1, 'a rendered template must misread the narrative as a stray answer')
  assert.equal(stray[0].id, 'ans-sum')
})
