import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { publishDeckIntoBook, qmdDeckChapterPairs, qmdDeckRenderRoots } from './build-qmd.mjs'

// The course's own shape: a deck named for a declared chapter, a deck named for
// nothing in the book, and a set declared by a render list that mixes a name
// rule with literal paths.
function deckProject() {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-deck-profile-'))
  mkdirSync(join(root, 'lectures'), { recursive: true })
  writeFileSync(join(root, '_quarto.yml'), [
    'project:',
    '  type: tlda',
    'book:',
    '  chapters:',
    '    - part: index.qmd',
    '      chapters:',
    '        - lectures/chapter-normal-approximation.qmd',
    '        - lectures/chapter-sampling.qmd',
    '',
  ].join('\n'))
  writeFileSync(join(root, '_quarto-slides.yml'), [
    'project:',
    '  type: default',
    '  render:',
    '    - lectures/*-slides.qmd',
    '    - lectures/Lecture2.qmd',
    '    - lectures/never-written.qmd',
    '    - lectures/._Lecture2.qmd',
    'book: null',
    '',
  ].join('\n'))
  for (const file of [
    'index.qmd',
    'lectures/chapter-normal-approximation.qmd',
    // Declared, and has no deck. Its absence is what the name rule reports by
    // returning nothing for it, rather than by finding some other file.
    'lectures/chapter-sampling.qmd',
    'lectures/chapter-normal-approximation-slides.qmd',
    // Matches `*-slides.qmd` and belongs to no declared chapter: the shape of
    // every abandoned lecture and backup sitting in the real deck directory.
    'lectures/Lab1-slides.qmd',
    'lectures/Lecture2.qmd',
    // macOS AppleDouble stubs, committed in the real project. Rendering one
    // fails the whole build.
    'lectures/._Lab1-slides.qmd',
    'lectures/._Lecture2.qmd',
  ]) writeFileSync(join(root, file), '# doc\n')
  return root
}

test('the deck set is the declared chapters name rule, plus literal entries', () => {
  const root = deckProject()
  try {
    // In chapter order, and `chapter-sampling` contributes nothing because it
    // has no deck. Literal entries follow, in the order the profile lists them.
    assert.deepEqual(qmdDeckRenderRoots(root), [
      'lectures/chapter-normal-approximation-slides.qmd',
      'lectures/Lecture2.qmd',
    ])
    // A declared entry with no file on disk is not a deck. Inferring one from
    // the name is what would claim a document nobody built.
    assert.equal(qmdDeckRenderRoots(root).includes('lectures/never-written.qmd'), false)
    // The file exists and matches `*-slides.qmd`. It is not in the book because
    // no declared chapter is named `Lab1`, and that is the whole difference
    // between reading the rule against the chapter list and against the
    // directory: the directory would have handed it over.
    assert.equal(qmdDeckRenderRoots(root).includes('lectures/Lab1-slides.qmd'), false)
    // A literal entry still names its own file, so the dotfile guard is still
    // the thing standing between an AppleDouble stub and a failed render.
    assert.equal(qmdDeckRenderRoots(root).includes('lectures/._Lecture2.qmd'), false)
    const skipped = []
    qmdDeckRenderRoots(root, (line) => skipped.push(line))
    assert.match(skipped.join('\n'), /skipping lectures\/\._Lecture2\.qmd/, 'a skipped deck must say so')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a project with no slides profile declares no decks', () => {
  const root = deckProject()
  try {
    rmSync(join(root, '_quarto-slides.yml'))
    assert.deepEqual(qmdDeckRenderRoots(root), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a deck pairs with its chapter by stem, and stands alone otherwise', () => {
  const root = deckProject()
  try {
    assert.deepEqual(qmdDeckChapterPairs(root), [
      { deck: 'lectures/chapter-normal-approximation-slides.qmd', chapter: 'lectures/chapter-normal-approximation.qmd' },
      // Declared literally, and its name matches no chapter at all — unpaired,
      // not forced onto one.
      { deck: 'lectures/Lecture2.qmd', chapter: null },
    ])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// Chapters and decks in separate directories, which is the layout the course is
// being reorganised into. Pairing by substituting `-slides.qmd` for `.qmd` in the
// deck's PATH assumes they share a directory, so under this layout every deck
// comes back unpaired -- and an unpaired deck groups under itself, which detaches
// it from its chapter's map. The build succeeds and every deck is in the wrong
// place, so nothing reports it.
test('a deck pairs with its chapter when they are in different directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-deck-split-'))
  try {
    mkdirSync(join(root, 'chapters'), { recursive: true })
    mkdirSync(join(root, 'decks'), { recursive: true })
    writeFileSync(join(root, '_quarto.yml'), [
      'project:', '  type: tlda', 'book:', '  chapters:',
      '    - chapters/chapter-normal-approximation.qmd', '',
    ].join('\n'))
    writeFileSync(join(root, '_quarto-slides.yml'), [
      'project:', '  type: default', '  render:', '    - decks/*-slides.qmd', 'book: null', '',
    ].join('\n'))
    for (const file of [
      'chapters/chapter-normal-approximation.qmd',
      'decks/chapter-normal-approximation-slides.qmd',
      'decks/Lab1-slides.qmd',
    ]) writeFileSync(join(root, file), '# doc\n')

    assert.deepEqual(qmdDeckChapterPairs(root), [
      // the chapter it belongs to is one directory over, and it still belongs to it
      {
        deck: 'decks/chapter-normal-approximation-slides.qmd',
        chapter: 'chapters/chapter-normal-approximation.qmd',
      },
    ])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// Two chapters can share a stem once directories are in play, and there is no
// correct way to choose between them. Leaving the deck unpaired is recoverable
// and visible; putting it on the wrong chapter's map is neither.
test('a deck whose stem matches two chapters is refused rather than guessed', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-deck-ambiguous-'))
  try {
    mkdirSync(join(root, 'part-one'), { recursive: true })
    mkdirSync(join(root, 'part-two'), { recursive: true })
    mkdirSync(join(root, 'decks'), { recursive: true })
    writeFileSync(join(root, '_quarto.yml'), [
      'project:', '  type: tlda', 'book:', '  chapters:',
      '    - part-one/estimation.qmd', '    - part-two/estimation.qmd', '',
    ].join('\n'))
    writeFileSync(join(root, '_quarto-slides.yml'), [
      'project:', '  type: default', '  render:', '    - decks/*-slides.qmd', 'book: null', '',
    ].join('\n'))
    for (const file of [
      'part-one/estimation.qmd', 'part-two/estimation.qmd', 'decks/estimation-slides.qmd',
    ]) writeFileSync(join(root, file), '# doc\n')

    const said = []
    assert.deepEqual(qmdDeckChapterPairs(root, line => said.push(line)), [
      { deck: 'decks/estimation-slides.qmd', chapter: null },
    ])
    assert.match(said.join('\n'), /more than one chapter is named estimation\.qmd/,
      'an ambiguous pairing must say why it was refused')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a deck render is moved into the book tree with its sidecar', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-deck-publish-'))
  try {
    mkdirSync(join(root, 'lectures', 'chapter-slides_files'), { recursive: true })
    mkdirSync(join(root, '_book', 'lectures'), { recursive: true })
    writeFileSync(join(root, 'lectures', 'chapter-slides.html'), 'new deck')
    writeFileSync(join(root, 'lectures', 'chapter-slides_files', 'figure.svg'), 'new figure')
    writeFileSync(join(root, '_book', 'lectures', 'chapter-slides.html'), 'old deck')

    assert.equal(publishDeckIntoBook(root, join(root, '_book'), 'lectures/chapter-slides.qmd'), true)

    assert.equal(readFileSync(join(root, '_book', 'lectures', 'chapter-slides.html'), 'utf8'), 'new deck')
    assert.equal(readFileSync(join(root, '_book', 'lectures', 'chapter-slides_files', 'figure.svg'), 'utf8'), 'new figure')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a deck nobody rendered publishes nothing and says so by returning false', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-deck-absent-'))
  try {
    mkdirSync(join(root, '_book'), { recursive: true })
    assert.equal(publishDeckIntoBook(root, join(root, '_book'), 'lectures/chapter-slides.qmd'), false)
    assert.equal(existsSync(join(root, '_book', 'lectures')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
