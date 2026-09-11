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

const publishedPage = (title) => `<!DOCTYPE html>\n<html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>\n`

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
// The edited component is a nested lecture chapter under a directory whose
// `_metadata.yml` declares revealjs, because that is the course shape this
// path serves and the shape the defect was reported on. A top-level
// `index.qmd` would exercise neither the nested output path nor the format
// the beside-the-source render would have substituted.
const CHAPTER = 'lectures/chapter-calibration-binary.qmd'
const CHAPTER_HTML = 'lectures/chapter-calibration-binary.html'

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
    writeFileSync(join(src, 'lectures', '_metadata.yml'), 'format: revealjs\n')
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
    // Format control. A beside-the-source render of this chapter is a DECK,
    // because lectures/_metadata.yml declares revealjs; publishing one over
    // the book page is how a deck replaced a prose chapter. A chapter rendered
    // inside the book project carries no reveal markers.
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
