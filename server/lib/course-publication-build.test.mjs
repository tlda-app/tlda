import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { assembleCoursePublication, buildCoursePublication, publicationMetadata } from './course-publication-build.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'course-publication-'))
  const course = join(root, 'course')
  const output = join(root, 'publication')
  for (const dir of ['chapters', 'decks', 'homework/handouts']) mkdirSync(join(course, dir), { recursive: true })
  writeFileSync(join(course, 'index.md'), [
    '[Chapter](chapters/one.qmd)',
    '[Slides](decks/one-slides.qmd)',
    '[Homework](homework/hw.html)',
    '[Download](homework/handouts/hw-handout.zip)',
  ].join('\n'))
  for (const rel of ['chapters/one.qmd', 'decks/one-slides.qmd', 'homework/hw.qmd', 'homework/handouts/hw-handout.zip']) {
    writeFileSync(join(course, rel), rel)
  }
  return { root, course, output }
}

function writeRender(renderedDir) {
  const rows = [
    ['chapters/unreleased.qmd', '_book/chapters/unreleased.html', 'Unreleased'],
    ['index.md', '_book/index.html', 'Course'],
    ['decks/one-slides.qmd', '_book/decks/one-slides.html', 'One — Slides'],
    ['chapters/one.qmd', '_book/chapters/one.html', 'One'],
    ['homework/hw.qmd', '_book/homework/hw.html', 'Homework'],
  ]
  const pages = rows.map(([source, file, title]) => ({ file, title, source: { file: source }, ...(source.startsWith('decks/') ? { variant: 'slides' } : {}) }))
  for (const page of pages) {
    mkdirSync(join(renderedDir, dirname(page.file)), { recursive: true })
    writeFileSync(join(renderedDir, page.file), `<link rel="next" href="./unreleased.html"><h1>${page.title}</h1><nav><a href="./unreleased.html"><span>Unreleased</span></a></nav>`)
    mkdirSync(join(renderedDir, dirname(page.source.file)), { recursive: true })
    writeFileSync(join(renderedDir, page.source.file), page.source.file)
  }
  writeFileSync(join(renderedDir, 'page-info.json'), JSON.stringify(pages))
  writeFileSync(join(renderedDir, 'toc.json'), JSON.stringify(pages.map((page, i) => ({ title: page.title, level: 'chapter', page: i + 1 }))))
}

async function assembleStatic({ courseDir, renderedDir, outputDir }) {
  mkdirSync(outputDir, { recursive: true })
  cpSync(join(renderedDir, '_book'), join(outputDir, 'book'), { recursive: true })
  mkdirSync(join(outputDir, 'book/homework/handouts'), { recursive: true })
  cpSync(join(courseDir, 'homework/handouts/hw-handout.zip'), join(outputDir, 'book/homework/handouts/hw-handout.zip'))
  writeFileSync(join(outputDir, 'index.html'), [
    '<a href="book/index.html">Course</a>',
    '<a href="book/chapters/one.html">Chapter</a>',
    '<a href="book/decks/one-slides.html">Slides</a>',
    '<a href="book/homework/hw.html">Homework</a>',
    '<a href="book/homework/handouts/hw-handout.zip">Download</a>',
  ].join('\n'))
}

test('one render feeds matching static and app publication trees', async () => {
  const { course, output } = fixture()
  let renders = 0
  await buildCoursePublication({
    courseDir: course,
    indexFile: 'index.md',
    outputDir: output,
    render: async renderedDir => {
      renders += 1
      writeRender(renderedDir)
    },
    assembleStatic,
  })
  assert.equal(renders, 1)
  assert.equal(existsSync(join(output, 'index.html')), true)
  assert.match(readFileSync(join(output, 'index.html'), 'utf8'), /url=\/static\//)
  assert.match(readFileSync(join(output, 'static/index.html'), 'utf8'), /book\/index\.html/)
  assert.equal(existsSync(join(output, 'static/book/chapters/one.html')), true)
  assert.equal(existsSync(join(output, 'app/book/chapters/one.html')), true)
  assert.equal(existsSync(join(output, 'static/book/decks/one-slides.html')), true)
  assert.equal(existsSync(join(output, 'app/book/decks/one-slides.html')), true)
  assert.equal(existsSync(join(output, 'static/book/chapters/unreleased.html')), false)
  assert.equal(existsSync(join(output, 'app/book/chapters/unreleased.html')), false)
  assert.equal(existsSync(join(output, 'static/book/chapters/unreleased.qmd')), false)
  assert.equal(existsSync(join(output, 'app/chapters/unreleased.qmd')), false)
  assert.doesNotMatch(readFileSync(join(output, 'static/book/chapters/one.html'), 'utf8'), /href="\.\/unreleased\.html"/)
  assert.doesNotMatch(readFileSync(join(output, 'app/book/chapters/one.html'), 'utf8'), /href="\.\/unreleased\.html"/)
  assert.match(readFileSync(join(output, 'static/book/chapters/one.html'), 'utf8'), /<span>Unreleased<\/span>/)
  assert.deepEqual(publicationMetadata(output).static, publicationMetadata(output).app)
})

test('identical inputs produce identical publication metadata without cleanup', async () => {
  const { course, output } = fixture()
  const run = () => buildCoursePublication({
    courseDir: course,
    indexFile: 'index.md',
    outputDir: output,
    render: async renderedDir => writeRender(renderedDir),
    assembleStatic,
  })
  await run()
  const first = JSON.stringify(publicationMetadata(output))
  await run()
  assert.equal(JSON.stringify(publicationMetadata(output)), first)
})

test('publication output cannot erase course source or the shared render', async () => {
  const { course } = fixture()
  const rendered = join(dirname(course), 'rendered')
  writeRender(rendered)
  await assert.rejects(
    () => assembleCoursePublication(course, 'index.md', rendered, course, assembleStatic),
    /must be separate/,
  )
  assert.equal(existsSync(join(course, 'index.md')), true)
  await assert.rejects(
    () => assembleCoursePublication(course, 'index.md', rendered, rendered, assembleStatic),
    /must be separate/,
  )
  assert.equal(existsSync(join(rendered, 'page-info.json')), true)
})
