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
