import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleQuartoBookToc } from './build-qmd.mjs'

test('the assembled book TOC includes every chapter and deck once', () => {
  const chapters = [
    { source: { file: 'index.qmd' } },
    { source: { file: 'lectures/sampling.qmd' } },
    { source: { file: 'references.qmd' } },
  ]
  const bookToc = [
    { title: 'Welcome', level: 'part', page: 1 },
    { title: 'Sampling', level: 'chapter', page: 2 },
    { title: 'References', level: 'chapter', page: 3 },
  ]
  const decks = [
    { title: 'Sampling', map: 'lectures/sampling.qmd' },
    { title: 'Welcome', map: 'index.qmd' },
    { title: 'Extra', map: 'lectures/extra.qmd' },
  ]
  assert.deepEqual(assembleQuartoBookToc(bookToc, chapters, decks), [
    { title: 'Welcome', level: 'part', page: 1 },
    { title: 'Welcome — Slides', level: 'section', page: 5 },
    { title: 'Sampling', level: 'chapter', page: 2 },
    { title: 'Sampling — Slides', level: 'section', page: 4 },
    { title: 'References', level: 'chapter', page: 3 },
    { title: 'Extra — Slides', level: 'chapter', page: 6 },
  ])
})

// The state most worth seeing was the one that deleted the place it would have
// been seen: a deck whose render fails produces no page, a deck with no page
// had no row, so the contents silently lost the chapter's slides. Live on his
// course 2026-09-20 — `chapter-social-pressure-experiment-slides.qmd` failed to
// render and is absent from all 33 rows.
test('a declared deck that did not render keeps its row, with no page', () => {
  const toc = assembleQuartoBookToc(
    [{ title: 'Sampling', level: 'chapter', page: 1 }],
    [{ source: { file: 'chapters/chapter-sampling.qmd' } }],
    [],
    [{ deck: 'decks/chapter-sampling-slides.qmd', chapter: 'chapters/chapter-sampling.qmd' }],
  )
  assert.deepEqual(toc, [
    { title: 'Sampling', level: 'chapter', page: 1 },
    { title: 'sampling — Slides', level: 'section', page: null, source: 'decks/chapter-sampling-slides.qmd', unbuilt: true },
  ])
})

// `page` numbers a row into `pages[n - 1]`, so there is no number that could be
// right for a row with no page — a wrong one sends the reader to somebody
// else's document, which is worse than a row that does not navigate.
test('an unbuilt row carries no page number rather than a plausible one', () => {
  const [, deckRow] = assembleQuartoBookToc(
    [{ title: 'Sampling', level: 'chapter', page: 1 }],
    [{ source: { file: 'chapters/chapter-sampling.qmd' } }],
    [],
    [{ deck: 'decks/chapter-sampling-slides.qmd', chapter: 'chapters/chapter-sampling.qmd' }],
  )
  assert.equal(deckRow.page, null)
  assert.equal(deckRow.source, 'decks/chapter-sampling-slides.qmd')
})
