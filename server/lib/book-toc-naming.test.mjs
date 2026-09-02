/**
 * A chapter is named after its topic, never after its position.
 *
 * Skip, 2026-09-01 06:11 EDT: "labs are not a thing." A lab is a chapter, and
 * `Lab 1` / `Lecture 2` is where something sits rather than what it is about.
 *
 * These run against a disposable fixture book, per AGENTS.md §"NEVER DISCUSS
 * HIS PAPERS. VERIFY ON A NEW PROJECT" — a claim demonstrated only against
 * something of his is not demonstrated.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { extractHtmlToc, stripPositionPrefix } from './html-toc-extractor.mjs'
import { aggregateBookToc, setProjectPathOverride } from './project-store.mjs'

const CHAPTER_HTML = `<html><body>
<section id="what-a-sample-is"><h2>What a sample is</h2></section>
</body></html>`

function writeMember(dir, { title, html = CHAPTER_HTML, file = 'chapter.html' }) {
  mkdirSync(join(dir, 'output'), { recursive: true })
  writeFileSync(join(dir, 'output', file), html)
  writeFileSync(join(dir, 'output', 'page-info.json'), JSON.stringify([
    { file, width: 1200, height: 900, title },
  ]))
  return join(dir, 'output')
}

test('the position prefix comes off, however it was punctuated', () => {
  assert.equal(stripPositionPrefix('Lab 1: Sampling'), 'Sampling')
  assert.equal(stripPositionPrefix('Lecture 2. Sampling'), 'Sampling')
  assert.equal(stripPositionPrefix('Lab 3 Sampling'), 'Sampling')
  assert.equal(stripPositionPrefix('lab 10 — Sampling'), 'Sampling')
  assert.equal(stripPositionPrefix('Lecture 4'), '')
  // Not a position: a chapter genuinely about labs, and a topic with a digit.
  assert.equal(stripPositionPrefix('Laboratory safety'), 'Laboratory safety')
  assert.equal(stripPositionPrefix('Sampling'), 'Sampling')
})

test('a member outside a part loses its position prefix in its own toc', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-toc-naming-'))
  try {
    const outputDir = writeMember(join(root, 'sampling'), { title: 'Lab 1: Sampling' })
    const toc = extractHtmlToc(outputDir)
    assert.equal(toc[0].title, 'Sampling')
    assert.equal(toc[0].level, 'chapter')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a title that was ONLY a position falls back to the document heading', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-toc-naming-bare-'))
  try {
    const outputDir = writeMember(join(root, 'sampling'), {
      title: 'Lecture 4',
      html: `<html><body><h1>Sampling distributions</h1>
<section id="s"><h2>What a sample is</h2></section></body></html>`,
    })
    assert.equal(extractHtmlToc(outputDir)[0].title, 'Sampling distributions')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a book carries the stripped chapter name through to its own toc', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-toc-naming-book-'))
  const book = join(root, 'course')
  const member = join(root, 'sampling')
  try {
    mkdirSync(join(book, 'output'), { recursive: true })
    const outputDir = writeMember(member, { title: 'Lab 1: Sampling' })
    writeFileSync(join(outputDir, 'toc.json'), JSON.stringify(extractHtmlToc(outputDir)))

    setProjectPathOverride('course-naming-fixture', book)
    setProjectPathOverride('sampling-naming-fixture', member)
    aggregateBookToc('course-naming-fixture', ['sampling-naming-fixture'])

    const bookToc = JSON.parse(readFileSync(join(book, 'output', 'toc.json'), 'utf8'))
    const titles = bookToc.map((entry) => entry.title)
    assert.ok(!titles.some((title) => /^(Lab|Lecture)\s+\d+/i.test(title)), `position prefix survived: ${titles.join(' | ')}`)
    assert.equal(bookToc[0].level, 'chapter')
  } finally {
    setProjectPathOverride('course-naming-fixture')
    setProjectPathOverride('sampling-naming-fixture')
    rmSync(root, { recursive: true, force: true })
  }
})
