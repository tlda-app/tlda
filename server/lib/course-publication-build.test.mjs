import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { assembleCoursePublication, buildCoursePublication, publicationMetadata, seedCoursePublicationRender } from './course-publication-build.mjs'
import { deriveCourseBookSpec } from './course-book-spec.mjs'
import { deriveCourseAppSpec } from './course-app-build.mjs'

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
  writeFileSync(join(course, '_quarto.yml'), 'project:\n  type: tlda\nbook:\n  title: Course\n  chapters:\n    - index.md\n    - chapters/one.qmd\n    - homework/hw.qmd\n')
  writeFileSync(join(course, '_quarto-slides.yml'), 'project:\n  type: default\n  render:\n    - decks/one-slides.qmd\n')
  return { root, course, output }
}

function writeRender(renderedDir) {
  const rows = [
    ['chapters/dormant.qmd', '_book/chapters/dormant.html', 'Dormant'],
    ['index.md', '_book/index.html', 'Course'],
    ['decks/one-slides.qmd', '_book/decks/one-slides.html', 'One — Slides'],
    ['chapters/one.qmd', '_book/chapters/one.html', 'One'],
    ['homework/hw.qmd', '_book/homework/hw.html', 'Homework'],
  ]
  const pages = rows.map(([source, file, title]) => ({ file, title, source: { file: source }, ...(source.startsWith('decks/') ? { variant: 'slides' } : {}) }))
  for (const page of pages) {
    mkdirSync(join(renderedDir, dirname(page.file)), { recursive: true })
    writeFileSync(join(renderedDir, page.file), `<link rel="next" href="./dormant.html"><h1>${page.title}</h1><nav><a href="./dormant.html"><span>Dormant</span></a></nav>`)
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
  assert.match(readFileSync(join(output, 'static/index.html'), 'utf8'), /book\/chapters\/one\.html/)
  assert.equal(existsSync(join(output, 'static/book/chapters/one.html')), true)
  assert.equal(existsSync(join(output, 'app/book/chapters/one.html')), true)
  assert.equal(existsSync(join(output, 'static/book/decks/one-slides.html')), true)
  assert.equal(existsSync(join(output, 'app/book/decks/one-slides.html')), true)
  assert.equal(existsSync(join(output, 'static/book/chapters/dormant.html')), false)
  assert.equal(existsSync(join(output, 'app/book/chapters/dormant.html')), false)
  assert.equal(existsSync(join(output, 'static/book/chapters/dormant.qmd')), false)
  assert.equal(existsSync(join(output, 'app/chapters/dormant.qmd')), false)
  assert.doesNotMatch(readFileSync(join(output, 'static/book/chapters/one.html'), 'utf8'), /href="\.\/dormant\.html"/)
  assert.doesNotMatch(readFileSync(join(output, 'app/book/chapters/one.html'), 'utf8'), /href="\.\/dormant\.html"/)
  assert.match(readFileSync(join(output, 'static/book/chapters/one.html'), 'utf8'), /<span>Dormant<\/span>/)
  assert.deepEqual(publicationMetadata(output).static, publicationMetadata(output).app)
})

test('a generated landing page that hides declared documents still publishes them', async () => {
  const { course, output } = fixture()
  const assembleDatedStatic = async args => {
    await assembleStatic(args)
    writeFileSync(join(args.outputDir, 'index.html'), '<a href="book/index.html">Course</a>')
  }
  await buildCoursePublication({
    courseDir: course,
    indexFile: 'index.md',
    outputDir: output,
    render: async renderedDir => writeRender(renderedDir),
    assembleStatic: assembleDatedStatic,
  })
  assert.equal(existsSync(join(output, 'static/book/chapters/one.html')), true)
  assert.equal(existsSync(join(output, 'static/book/decks/one-slides.html')), true)
  assert.equal(existsSync(join(output, 'app/book/chapters/one.html')), true)
  assert.equal(existsSync(join(output, 'app/book/decks/one-slides.html')), true)
  assert.equal(existsSync(join(output, 'static/book/chapters/dormant.html')), false)
  assert.equal(existsSync(join(output, 'app/book/chapters/dormant.html')), false)
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

test('a seeded chapter render republishes one changed page without losing the complete course', async () => {
  const { course, output } = fixture()
  await buildCoursePublication({
    courseDir: course,
    indexFile: 'index.md',
    outputDir: output,
    render: async renderedDir => writeRender(renderedDir),
    assembleStatic,
  })
  const untouched = readFileSync(join(output, 'app/book/homework/hw.html'), 'utf8')

  await buildCoursePublication({
    courseDir: course,
    indexFile: 'index.md',
    outputDir: output,
    seedRender: renderedDir => seedCoursePublicationRender(output, renderedDir),
    render: async renderedDir => {
      assert.equal(existsSync(join(renderedDir, '_book/chapters/one.html')), true)
      assert.equal(existsSync(join(renderedDir, '_book/homework/hw.html')), true)
      writeFileSync(join(renderedDir, '_book/chapters/one.html'), '<h1>One changed chapter</h1>')
    },
    assembleStatic,
  })

  assert.match(readFileSync(join(output, 'app/book/chapters/one.html'), 'utf8'), /One changed chapter/)
  assert.match(readFileSync(join(output, 'static/book/chapters/one.html'), 'utf8'), /One changed chapter/)
  assert.equal(readFileSync(join(output, 'app/book/homework/hw.html'), 'utf8'), untouched)
  assert.deepEqual(publicationMetadata(output).static, publicationMetadata(output).app)
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

test('real qtm285 publication preserves app chrome and merges all current schedule refs', {
  skip: !process.env.TLDA_QTM285_SOURCE_DIR || !process.env.TLDA_QTM285_STATIC_DIR || !process.env.TLDA_QTM285_APP_INDEX,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'course-publication-qtm285-'))
  const course = join(root, 'course')
  const staticInput = join(root, 'static-input')
  const appIndex = join(root, 'app-index.html')
  const output = join(root, 'publication')
  const sourceSpec = deriveCourseBookSpec(process.env.TLDA_QTM285_SOURCE_DIR)
  const announcementSpec = deriveCourseAppSpec(process.env.TLDA_QTM285_SOURCE_DIR, join(process.env.TLDA_QTM285_STATIC_DIR, 'index.html'))
  const sourceInputs = new Set([
    'index.qmd',
    '_quarto.yml',
    '_quarto-slides.yml',
    ...sourceSpec.documents,
    ...sourceSpec.decks,
    ...announcementSpec.assets,
  ])
  for (const rel of sourceInputs) {
    const destination = join(course, rel)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(join(process.env.TLDA_QTM285_SOURCE_DIR, rel), destination, { recursive: true })
  }
  cpSync(process.env.TLDA_QTM285_STATIC_DIR, staticInput, { recursive: true })
  cpSync(process.env.TLDA_QTM285_APP_INDEX, appIndex)

  const copiedSourceSpec = deriveCourseBookSpec(course)
  const pages = [
    ...copiedSourceSpec.documents.map(source => ({ source, file: source === 'index.qmd' ? '_book/index.html' : `_book/${source.replace(/\.qmd$/i, '.html')}`, title: source })),
    ...copiedSourceSpec.decks.map(source => ({ source, file: `_book/${source.replace(/\.qmd$/i, '.html')}`, title: source, variant: 'slides' })),
  ]
  const render = async renderedDir => {
    for (const page of pages) {
      mkdirSync(join(renderedDir, dirname(page.file)), { recursive: true })
      writeFileSync(join(renderedDir, page.file), page.source === 'index.qmd'
        ? readFileSync(appIndex, 'utf8')
        : `<main><h1>${page.title}</h1></main>`)
      mkdirSync(join(renderedDir, dirname(page.source)), { recursive: true })
      writeFileSync(join(renderedDir, page.source), page.source)
    }
    writeFileSync(join(renderedDir, 'page-info.json'), JSON.stringify(pages.map(({ source, file, title, variant }) => ({ file, title, source: { file: source }, ...(variant ? { variant } : {}) }))))
    writeFileSync(join(renderedDir, 'toc.json'), JSON.stringify(pages.map((page, index) => ({ title: page.title, level: page.variant === 'slides' ? 'section' : 'chapter', page: index + 1 }))))
  }
  const assembleStaticFromRealCopy = async ({ outputDir }) => cpSync(staticInput, outputDir, { recursive: true })

  await buildCoursePublication({
    courseDir: course,
    indexFile: join(staticInput, 'index.html'),
    outputDir: output,
    render,
    assembleStatic: assembleStaticFromRealCopy,
  })

  const staticIndex = readFileSync(join(output, 'static/index.html'), 'utf8')
  const appIndexHtml = readFileSync(join(output, 'app/book/index.html'), 'utf8')
  const schedule = staticIndex.match(/<div\b[^>]*id=["']schedule["'][\s\S]*?<\/div>/i)?.[0]
  assert.ok(schedule, 'real static index has a schedule section')
  const refs = [...schedule.matchAll(/<a\b[^>]*\bhref=(['"])(.*?)\1/gi)].map(match => match[2])
  assert.equal(refs.length, 21)
  for (const ref of refs) {
    const target = ref.replace(/^book\//, '')
    assert.equal(existsSync(join(output, 'app/book', target)), true, `app schedule target resolves: ${target}`)
  }
  assert.equal((appIndexHtml.match(/<(?:section|div)\b[^>]*\bid=["']schedule["']/gi) || []).length, 1)
  assert.match(appIndexHtml, /id=["']TOC["']/)
  assert.match(appIndexHtml, /site_libs\/quarto-html\/quarto\.js/)
  assert.match(appIndexHtml, /course-now/)
  assert.match(appIndexHtml, /T Nov 3/)
  assert.match(appIndexHtml, /Dec 10[–-]19/)
  assert.doesNotMatch(appIndexHtml, /id=["']practices["']/)
  assert.doesNotMatch(appIndexHtml, /site-assets\/css\/skeleton\.css/)
  assert.match(appIndexHtml, /href=["'](?:\.\/)?chapters\/chapter-sampling\.html["']/)
  // Counterfactual: without production mergeAppIndexSchedule wiring this
  // static-only deck link is absent from the app index.
  assert.match(appIndexHtml, /href=["']decks\/chapter-sampling-slides\.html["']/)
  assert.match(appIndexHtml, /\[solutions\]/)
  assert.doesNotMatch(appIndexHtml, /href=["']homework\/homework-calibration-solutions\.html["']/)
})
