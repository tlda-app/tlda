import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildQmdDocument } from './build-qmd.mjs'
import { closeProjectStore, createProject, initProjectStore, outputDir, sourceDir } from './project-store.mjs'

const EXTENSION = fileURLToPath(new URL('../../extensions/tlda/_extensions/tlda', import.meta.url))
const hasQuarto = (() => {
  try { execFileSync('sh', ['-c', 'command -v quarto'], { stdio: 'ignore' }); return true } catch { return false }
})()

// Two real renders, minutes long, against a suite that kills a file at 120s
// (`bin/run-test-suite.mjs`, DEFAULT_TIMEOUT_MS). Run by default this control
// goes red on load rather than on a defect, and a check that flakes red teaches
// people to ignore red. So it is deliberate rather than automatic, and the
// release runbook names it.
const RENDER_CONTROL_SKIP = process.env.TLDA_QUARTO_RENDER_TESTS === '1'
  ? (hasQuarto ? false : 'quarto not on PATH')
  : 'set TLDA_QUARTO_RENDER_TESTS=1 to run — a real Quarto render, minutes long; this control must pass before any build-path change ships'

const CHAPTER = 'lectures/chapter-calibration-binary.qmd'
const CHAPTER_HTML = 'lectures/chapter-calibration-binary.html'
const DECK = 'lectures/chapter-calibration-binary-slides.qmd'
const DECK_HTML = 'lectures/chapter-calibration-binary-slides.html'

const publishedPage = (title) => `<!DOCTYPE html>\n<html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>\n`

/**
 * A chapter and its deck are two renders of two files, and never each other.
 *
 * The chapter renders inside the book project and must come out prose, even
 * though `lectures/_metadata.yml` declares revealjs — that metadata is why a
 * render taken outside the book produces a deck, and publishing one of those
 * over the chapter is how a prose page was lost. The deck renders under the
 * `slides` profile, where `project: type: default` makes a deck beside its own
 * source the correct answer.
 *
 * So this asserts both halves at once on one build: the same build that leaves
 * the chapter free of reveal markers must leave the deck full of them.
 */
test('a component build renders the chapter as prose and its deck as a deck', { timeout: 900_000, skip: RENDER_CONTROL_SKIP }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-deck-render-'))
  const project = 'deck-render-fixture'
  try {
    await initProjectStore(join(root, 'projects'))
    createProject({ name: project, mainFile: 'index.qmd', format: 'qmd', documentRoots: ['index.qmd'] })

    const src = sourceDir(project)
    mkdirSync(join(src, '_extensions'), { recursive: true })
    cpSync(EXTENSION, join(src, '_extensions', 'tlda'), { recursive: true })
    mkdirSync(join(src, 'lectures'), { recursive: true })
    writeFileSync(join(src, '_quarto.yml'), [
      'project:',
      '  type: tlda',
      'book:',
      '  title: "Deck Fixture"',
      '  chapters:',
      '    - index.qmd',
      `    - ${CHAPTER}`,
      '',
    ].join('\n'))
    // No `book:` key. Quarto 1.9.38 rejects `book: null` outright — "Field
    // book has value null, which must instead be an object" — and the project
    // whose profile this mirrors carries that line, so its deck profile does
    // not load at all on the installed Quarto. `project: type: default` is what
    // makes a deck render beside its source; the book key is not needed for it.
    writeFileSync(join(src, '_quarto-slides.yml'), [
      'project:',
      '  type: default',
      '  render:',
      '    - lectures/*-slides.qmd',
      'format:',
      '  revealjs:',
      '    embed-resources: true',
      '',
    ].join('\n'))
    writeFileSync(join(src, 'lectures', '_metadata.yml'), 'format: revealjs\n')
    writeFileSync(join(src, 'index.qmd'), '# Introduction\n\nOpening text.\n')
    writeFileSync(join(src, CHAPTER), '# Calibration\n\n## Binary outcomes\n\nChapter text, revised in place.\n')
    writeFileSync(join(src, DECK), '# Calibration\n\n## A slide\n\nDeck text, revised in place.\n')

    const out = outputDir(project)
    mkdirSync(join(out, '_book', 'lectures'), { recursive: true })
    writeFileSync(join(out, '_book', 'index.html'), publishedPage('Introduction'))
    writeFileSync(join(out, '_book', CHAPTER_HTML), publishedPage('Calibration'))
    writeFileSync(join(out, '_book', 'tlda-manifest.json'), `${JSON.stringify({
      version: 1,
      kind: 'tlda',
      pages: [
        { file: 'index.html', title: 'Introduction', source: { type: 'project-source', format: 'qmd', file: 'index.qmd' } },
        { file: CHAPTER_HTML, title: 'Calibration', source: { type: 'project-source', format: 'qmd', file: CHAPTER } },
      ],
    }, null, 2)}\n`)

    await buildQmdDocument(project, () => {}, { changedFiles: [CHAPTER] })

    const chapter = readFileSync(join(out, '_book', CHAPTER_HTML), 'utf8')
    assert.match(chapter, /revised in place/, 'the edited chapter must be republished into _book')
    assert.doesNotMatch(chapter, /class="reveal"/, 'a book chapter must not be published as a deck')

    const deck = readFileSync(join(out, '_book', DECK_HTML), 'utf8')
    assert.match(deck, /revised in place/, "the chapter's deck must be rebuilt alongside it")
    assert.match(deck, /class="reveal"/, 'a deck must still be published as a deck')

    const pageInfo = JSON.parse(readFileSync(join(out, 'page-info.json'), 'utf8'))
    const deckEntry = pageInfo.find((entry) => entry.variant === 'slides')
    assert.ok(deckEntry, `expected a slides entry, got ${JSON.stringify(pageInfo.map((e) => e.file))}`)
    // What the map layer keys on: the deck sits on its CHAPTER's map, while
    // still naming its own source file as the document an edit lands in.
    assert.equal(deckEntry.group, CHAPTER)
    assert.equal(deckEntry.source.file, DECK)
    assert.equal(deckEntry.file, `_book/${DECK_HTML}`)
    assert.ok(deckEntry.slides.length > 0, 'a deck entry carries its slides as its address space')

    // One entry per deck, never one per slide — a canvas of far-flung documents
    // is what the per-slide shape produced.
    assert.equal(pageInfo.filter((entry) => entry.variant === 'slides').length, 1)
    // The chapter groups under itself — one map per chapter — which is the same
    // key its paired deck names, and is how the two land together.
    const chapterEntry = pageInfo.find((entry) => entry.source?.file === CHAPTER && entry.variant !== 'slides')
    assert.ok(chapterEntry, 'the chapter must still have its own entry')
    assert.equal(chapterEntry.group, CHAPTER)
    assert.deepEqual(
      pageInfo.filter((entry) => entry.variant !== 'slides').map((entry) => entry.source.file),
      ['index.qmd', CHAPTER],
      'chapters stay contiguous and in manifest order, because toc.json numbers them by position',
    )
  } finally {
    await closeProjectStore().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})
