import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// A real render takes minutes, and the suite kills a file at 120s
// (`bin/run-test-suite.mjs`, DEFAULT_TIMEOUT_MS) — a chapter render measured
// 56s on a quiet machine and 200s on a busy one. Run by default, this control
// goes red on load, and a check that flakes red teaches people to ignore red.
// So it is deliberate rather than automatic. It is still a gate: the release
// runbook names it.
const RENDER_CONTROL_SKIP = process.env.TLDA_QUARTO_RENDER_TESTS === '1'
  ? (hasQuarto ? false : 'quarto not on PATH')
  : 'set TLDA_QUARTO_RENDER_TESTS=1 to run — a real Quarto render, minutes long; this control must pass before any build-path change ships'

const publishedPage = (title) => `<!DOCTYPE html>
<html><head><title>${title}</title></head><body>
<nav id="quarto-sidebar"><div class="sidebar-menu-container"><ul>
<li class="sidebar-item"><div class="sidebar-item-container"><a class="sidebar-link" href="index.html"><span class="chapter-title">Introduction</span></a></div></li>
<li class="sidebar-item"><div class="sidebar-item-container"><a class="sidebar-link" href="lectures/chapter-calibration-binary.html"><span class="chapter-title">Calibration</span></a></div></li>
</ul></div></nav>
<h1>${title}</h1></body></html>\n`

/**
 * A component build renders ONE chapter over the last published book.
 *
 * Quarto renders a book component as part of its project: `quarto render
 * lectures/chapter.qmd` writes `_book/lectures/chapter.html` and leaves
 * nothing beside the .qmd. A build step that looks for the component's HTML
 * next to its source therefore fails every component build, on a render that
 * already succeeded and already wrote the page.
 *
 * Only a real render can hold that, because the defect is about where Quarto
 * puts the file. A fixture that writes the rendered HTML itself asserts the
 * premise instead of testing it.
 *
 * The prior `_book` is written by hand rather than rendered: in production it
 * is seeded from the live project's output, and its bytes do not change what
 * Quarto does with the chapter under test. That keeps this to one render.
 */
// The edited component is a nested lecture chapter, which exercises the
// course's nested output path. Format-specific deck metadata belongs on the
// deck sources; directory metadata would change the chapter's own format.
const CHAPTER = 'lectures/chapter-calibration-binary.qmd'
const CHAPTER_HTML = 'lectures/chapter-calibration-binary.html'

// A seeded two-chapter book: real sources, hand-written prior `_book` the way
// the build instance receives it from the live project (test 1 documents why
// the seed stays hand-written).
function writeSeededBook(src, out, { indexSource, chapterSource }) {
  mkdirSync(join(src, '_extensions'), { recursive: true })
  cpSync(EXTENSION, join(src, '_extensions', 'tlda'), { recursive: true })
  mkdirSync(join(src, 'lectures'), { recursive: true })
  writeFileSync(join(src, '_quarto.yml'), [
    'project:',
    '  type: tlda',
    'book:',
    '  title: "Scope Fixture"',
    '  chapters:',
    '    - index.qmd',
    `    - ${CHAPTER}`,
    '',
  ].join('\n'))
  writeFileSync(join(src, 'index.qmd'), indexSource)
  writeFileSync(join(src, CHAPTER), chapterSource)
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
}

test('a direct chapter edit rebuilds that chapter into the book', { timeout: 900_000, skip: RENDER_CONTROL_SKIP }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-component-render-'))
  const project = 'component-render-fixture'
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
      '  title: "Component Fixture"',
      '  chapters:',
      '    - index.qmd',
      `    - ${CHAPTER}`,
      '',
    ].join('\n'))
    writeFileSync(join(src, 'index.qmd'), '# Introduction\n\nOpening text.\n')
    writeFileSync(join(src, CHAPTER), '# Calibration\n\n## Binary outcomes\n\nChapter text, revised in place.\n')

    // The last published render, as the build instance receives it.
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
    const untouchedPath = join(out, '_book', 'index.html')
    const untouchedBefore = readFileSync(untouchedPath, 'utf8')

    const log = []
    await buildQmdDocument(project, (line) => log.push(String(line)), { changedFiles: [CHAPTER] })

    // The edit reached the book page the viewer serves, at its nested path.
    const chapter = readFileSync(join(out, '_book', CHAPTER_HTML), 'utf8')
    assert.match(chapter, /revised in place/, 'the edited chapter must be republished into _book')
    // Format control: a chapter must remain prose.
    assert.doesNotMatch(chapter, /class="reveal"/, 'a book chapter must not be published as a deck')
    // The chapter nobody touched was neither re-rendered nor lost.
    assert.equal(existsSync(untouchedPath), true, 'an untouched chapter must survive a component build')
    assert.equal(readFileSync(untouchedPath, 'utf8'), untouchedBefore, 'an untouched chapter must not be re-rendered')

    const manifest = JSON.parse(readFileSync(join(out, '_book', 'tlda-manifest.json'), 'utf8'))
    assert.deepEqual(
      manifest.pages.map((page) => page.file),
      ['index.html', CHAPTER_HTML],
      'the complete book manifest must survive a component build',
    )
    assert.equal(JSON.parse(readFileSync(join(out, 'page-info.json'), 'utf8')).length, 2)

    // The fixture really took the component branch, so a pass cannot come from
    // a whole-project render having rebuilt everything. That branch logs
    // `quarto render` with no target.
    assert.match(log.join('\n'), new RegExp(`\\[qmd\\] quarto render ${CHAPTER}$`, 'm'), 'fixture must have built through the component branch')
  } finally {
    await closeProjectStore().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})

test('a first build renders only the declared chapter root', { timeout: 900_000, skip: RENDER_CONTROL_SKIP }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-declared-root-'))
  const project = 'declared-root-fixture'
  try {
    await initProjectStore(join(root, 'projects'))
    createProject({ name: project, mainFile: CHAPTER, format: 'qmd', documentRoots: [CHAPTER] })

    const src = sourceDir(project)
    mkdirSync(join(src, '_extensions'), { recursive: true })
    cpSync(EXTENSION, join(src, '_extensions', 'tlda'), { recursive: true })
    mkdirSync(join(src, 'lectures'), { recursive: true })
    mkdirSync(join(src, 'assets'), { recursive: true })
    writeFileSync(join(src, '_quarto.yml'), [
      'project:',
      '  type: tlda',
      'book:',
      '  title: "Declared Root Fixture"',
      '  chapters:',
      '    - index.qmd',
      `    - ${CHAPTER}`,
      '',
    ].join('\n'))
    writeFileSync(join(src, 'index.qmd'), '# Introduction\n\nThis page is outside the declared roots.\n')
    writeFileSync(join(src, 'assets', 'proof.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>\n')
    writeFileSync(join(src, CHAPTER), '# Calibration\n\nOnly this chapter is published.\n\n![](../assets/proof.svg)\n')

    const log = []
    await buildQmdDocument(project, (line) => log.push(String(line)), { changedFiles: [CHAPTER] })

    const out = outputDir(project)
    assert.equal(existsSync(join(out, '_book', CHAPTER_HTML)), true)
    assert.equal(existsSync(join(out, '_book', 'assets', 'proof.svg')), true)
    assert.equal(existsSync(join(out, CHAPTER)), false)
    assert.equal(existsSync(join(out, '_quarto.yml')), false)
    assert.equal(existsSync(join(out, '_extensions')), false)
    assert.equal(existsSync(join(out, '.quarto')), false)
    assert.equal(existsSync(join(out, '_freeze')), false)
    const pageInfo = JSON.parse(readFileSync(join(out, 'page-info.json'), 'utf8'))
    assert.deepEqual(pageInfo.map((page) => page.file), [`_book/${CHAPTER_HTML}`])
    assert.match(log.join('\n'), new RegExp(`^\\[qmd\\] quarto render ${CHAPTER}$`, 'm'))
    assert.match(readFileSync(join(src, '_quarto.yml'), 'utf8'), /- index\.qmd/)

    writeFileSync(join(src, CHAPTER), '# Calibration\n\nThe second edit reached the page.\n\n![](../assets/proof.svg)\n')
    await buildQmdDocument(project, (line) => log.push(String(line)), { changedFiles: [CHAPTER] })
    assert.match(readFileSync(join(out, '_book', CHAPTER_HTML), 'utf8'), /The second edit reached the page\./)
    assert.equal(log.filter((line) => line === `[qmd] quarto render ${CHAPTER}`).length, 2)
  } finally {
    await closeProjectStore().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})

test('a mixed chapter-plus-config edit still rebuilds the chapter', { timeout: 900_000, skip: RENDER_CONTROL_SKIP }, async () => {
  // The acceptance case: chapter + `_quarto.yml` once rendered only index.qmd
  // — the stale-fallback substituting the wrong set — while the chapter edit
  // sat missing from its page and the build reported success. Config widens to
  // the whole project now, and the widening says which file caused it.
  // The link in index.qmd is load-bearing: without something stale to
  // substitute, the old code widened too and this passed anyway.
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-mixed-scope-'))
  const project = 'mixed-scope-fixture'
  try {
    await initProjectStore(join(root, 'projects'))
    createProject({ name: project, mainFile: 'index.qmd', format: 'qmd', documentRoots: ['index.qmd'] })

    const src = sourceDir(project)
    const out = outputDir(project)
    writeSeededBook(src, out, {
      indexSource: '# Introduction\n\nSee [calibration](lectures/chapter-calibration-binary.qmd).\n',
      chapterSource: '# Calibration\n\nThe mixed-scope sentence must appear.\n',
    })

    const log = []
    await buildQmdDocument(project, (line) => log.push(String(line)), { changedFiles: [CHAPTER, '_quarto.yml'] })

    assert.match(
      readFileSync(join(out, '_book', CHAPTER_HTML), 'utf8'),
      /mixed-scope sentence must appear/,
      'the edited chapter must be republished when config widens the scope',
    )
    assert.match(log.join('\n'), /^\[qmd\] quarto render\s*$/m, 'config widens to a whole-project render')
    assert.match(log.join('\n'), /full-project scope because project configuration changed: _quarto\.yml/)
  } finally {
    await closeProjectStore().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})

test('repeated incremental builds leave rendered pages byte-identical', { timeout: 900_000, skip: RENDER_CONTROL_SKIP }, async () => {
  // The accretion guard at build level: the post-render loop reprocessed
  // seeded pages and source-line marking is not idempotent across passes
  // (measured +184 bytes on an untouched course chapter), so untouched pages
  // drifted a little every build. Three builds — render the chapter, then two
  // edits to index — comparing the chapter page after each. The repeated
  // phrases stress the multi-pass matcher the way course prose does.
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-seeded-stable-'))
  const project = 'seeded-stable-fixture'
  try {
    await initProjectStore(join(root, 'projects'))
    createProject({ name: project, mainFile: 'index.qmd', format: 'qmd', documentRoots: ['index.qmd'] })

    const src = sourceDir(project)
    const out = outputDir(project)
    writeSeededBook(src, out, {
      indexSource: '# Introduction\n\nOpening text.\n',
      chapterSource: '# Calibration\n\n## Binary outcomes\n\nCalibration text one.\n\n## Binary outcomes again\n\nCalibration text one, repeated.\n',
    })

    const log = []
    const chapterPath = join(out, '_book', CHAPTER_HTML)
    await buildQmdDocument(project, (line) => log.push(String(line)), { changedFiles: [CHAPTER] })
    const renderedOnce = readFileSync(chapterPath, 'utf8')

    writeFileSync(join(src, 'index.qmd'), '# Introduction\n\nOpening text.\n\nSecond paragraph.\n')
    await buildQmdDocument(project, (line) => log.push(String(line)), { changedFiles: ['index.qmd'] })
    assert.equal(readFileSync(chapterPath, 'utf8'), renderedOnce, 'the chapter page must survive a second build byte-identical')

    writeFileSync(join(src, 'index.qmd'), '# Introduction\n\nOpening text.\n\nSecond paragraph.\n\nThird paragraph.\n')
    await buildQmdDocument(project, (line) => log.push(String(line)), { changedFiles: ['index.qmd'] })
    assert.equal(readFileSync(chapterPath, 'utf8'), renderedOnce, 'the chapter page must survive a third build byte-identical')

    assert.equal(log.filter((line) => line === `[qmd] quarto render ${CHAPTER}`).length, 1)
    assert.equal(log.filter((line) => line === '[qmd] quarto render index.qmd').length, 2)
  } finally {
    await closeProjectStore().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})
