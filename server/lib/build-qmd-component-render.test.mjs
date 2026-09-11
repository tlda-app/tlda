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

const publishedPage = (title) => `<!DOCTYPE html>\n<html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>\n`

/**
 * A component build renders ONE chapter over the last published book.
 *
 * Quarto renders a book component as part of its project: `quarto render
 * index.qmd` writes `_book/index.html` and leaves nothing beside the .qmd. A
 * build step that looks for the component's HTML next to its source therefore
 * fails every component build, on a render that already succeeded and already
 * wrote the page.
 *
 * Only a real render can hold that, because the defect is about where Quarto
 * puts the file. A fixture that writes the rendered HTML itself asserts the
 * premise instead of testing it.
 *
 * The prior `_book` is written by hand rather than rendered: in production it
 * is seeded from the live project's output, and its bytes do not change what
 * Quarto does with the chapter under test. That keeps this to one render.
 */
test('a direct chapter edit rebuilds that chapter into the book', { timeout: 300_000, skip: hasQuarto ? false : 'quarto not on PATH' }, async () => {
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
      '    - lectures/chapter-one.qmd',
      '',
    ].join('\n'))
    writeFileSync(join(src, 'index.qmd'), '# Introduction\n\nOpening text, revised in place.\n')
    writeFileSync(join(src, 'lectures', 'chapter-one.qmd'), '# Chapter One\n\nChapter text.\n')

    // The last published render, as the build instance receives it.
    const out = outputDir(project)
    mkdirSync(join(out, '_book', 'lectures'), { recursive: true })
    writeFileSync(join(out, '_book', 'index.html'), publishedPage('Introduction'))
    writeFileSync(join(out, '_book', 'lectures', 'chapter-one.html'), publishedPage('Chapter One'))
    writeFileSync(join(out, '_book', 'tlda-manifest.json'), `${JSON.stringify({
      version: 1,
      kind: 'tlda',
      pages: [
        { file: 'index.html', title: 'Introduction', source: { type: 'project-source', format: 'qmd', file: 'index.qmd' } },
        { file: 'lectures/chapter-one.html', title: 'Chapter One', source: { type: 'project-source', format: 'qmd', file: 'lectures/chapter-one.qmd' } },
      ],
    }, null, 2)}\n`)
    const chapterPath = join(out, '_book', 'lectures', 'chapter-one.html')
    const chapterBefore = readFileSync(chapterPath, 'utf8')

    const log = []
    await buildQmdDocument(project, (line) => log.push(String(line)), { changedFiles: ['index.qmd'] })

    // The edit reached the book page the viewer serves.
    assert.match(
      readFileSync(join(out, '_book', 'index.html'), 'utf8'),
      /revised in place/,
      'the edited chapter must be republished into _book',
    )
    // The chapter nobody touched was neither re-rendered nor lost.
    assert.equal(existsSync(chapterPath), true, 'an untouched chapter must survive a component build')
    assert.equal(readFileSync(chapterPath, 'utf8'), chapterBefore, 'an untouched chapter must not be re-rendered')

    const manifest = JSON.parse(readFileSync(join(out, '_book', 'tlda-manifest.json'), 'utf8'))
    assert.deepEqual(
      manifest.pages.map((page) => page.file),
      ['index.html', 'lectures/chapter-one.html'],
      'the complete book manifest must survive a component build',
    )
    assert.equal(JSON.parse(readFileSync(join(out, 'page-info.json'), 'utf8')).length, 2)

    // The fixture really took the component branch, so a pass cannot come from
    // a whole-project render having rebuilt everything. That branch logs
    // `quarto render` with no target.
    assert.match(log.join('\n'), /\[qmd\] quarto render index\.qmd$/m, 'fixture must have built through the component branch')
  } finally {
    await closeProjectStore().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})
