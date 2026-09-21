import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assembleCourseAppSite, copyCourseAppAssets, deriveCourseAppSpec, mergeStaticScheduleLinks } from './course-app-build.mjs'
import { deriveCourseBookSpec } from './course-book-spec.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'course-app-build-'))
  for (const dir of ['chapters', 'decks', 'homework/handouts']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'index.qmd'), [
    '[Chapter](chapters/one.qmd)',
    '[Slides](decks/one-slides.qmd)',
    '[Homework](homework/hw.html)',
    '[Download](homework/handouts/hw-handout.zip)',
    '![](example-that-need-not-exist.png)',
    '[External](https://example.com/nope)',
  ].join('\n'))
  for (const path of ['chapters/one.qmd', 'decks/one-slides.qmd', 'homework/hw.qmd', 'homework/handouts/hw-handout.zip']) {
    writeFileSync(join(root, path), path)
  }
  writeFileSync(join(root, '_quarto.yml'), 'project:\n  type: tlda\nbook:\n  title: Course\n  chapters: [old.qmd]\n')
  writeFileSync(join(root, '_quarto-slides.yml'), 'project:\n  type: default\n  render: [decks/old.qmd]\n')
  return root
}

test('course app spec comes from index links and real course counterparts', () => {
  const root = fixture()
  const spec = deriveCourseAppSpec(root, 'index.qmd')
  assert.deepEqual(spec.documents, ['index.qmd', 'chapters/one.qmd', 'homework/hw.qmd'])
  assert.deepEqual(spec.decks, ['decks/one-slides.qmd'])
  assert.deepEqual(spec.assets, ['homework/handouts/hw-handout.zip'])
  assert.equal(spec.links.includes('https://example.com/nope'), false)
})

test('generated static index is the release authority for the app tree', () => {
  const root = fixture()
  const publication = join(mkdtempSync(join(tmpdir(), 'course-release-index-')), 'index.html')
  writeFileSync(publication, [
    '<a href="book/chapters/one.html">Chapter</a>',
    '<a href="book/decks/one-slides.html">Slides</a>',
    '<a href="book/homework/hw.html">Homework</a>',
    '<a href="book/homework/handouts/hw-handout.zip">Download</a>',
  ].join('\n'))
  const spec = deriveCourseAppSpec(root, publication)
  assert.deepEqual(spec.documents, ['index.qmd', 'chapters/one.qmd', 'homework/hw.qmd'])
  assert.deepEqual(spec.decks, ['decks/one-slides.qmd'])
  assert.deepEqual(spec.assets, ['homework/handouts/hw-handout.zip'])
})

test('a missing local publication target fails with the evidence inline', () => {
  const root = fixture()
  writeFileSync(join(root, 'index.qmd'), '[Missing](chapters/not-there.qmd)')
  assert.throws(() => deriveCourseAppSpec(root, 'index.qmd'), /local publication link has no course input: chapters\/not-there\.qmd/)
})

test('membership comes from the authored declarations, not the index links', () => {
  const root = fixture()
  writeFileSync(join(root, '_quarto.yml'), 'project:\n  type: tlda\nbook:\n  title: Course\n  chapters:\n    - index.qmd\n    - chapters/one.qmd\n    - homework/hw.qmd\n')
  writeFileSync(join(root, '_quarto-slides.yml'), 'project:\n  type: default\n  render:\n    - decks/one-slides.qmd\n')
  writeFileSync(join(root, 'index.qmd'), '[Chapter](chapters/one.qmd)')
  const spec = deriveCourseBookSpec(root)
  assert.deepEqual(spec.documents, ['index.qmd', 'chapters/one.qmd', 'homework/hw.qmd'])
  assert.deepEqual(spec.decks, ['decks/one-slides.qmd'])
})

test('a linked deck is recognized outside a decks directory', () => {
  const root = fixture()
  mkdirSync(join(root, 'lectures'))
  writeFileSync(join(root, 'lectures/one-slides.qmd'), 'slides')
  writeFileSync(join(root, 'index.qmd'), '[Slides](lectures/one-slides.qmd)')
  assert.deepEqual(deriveCourseAppSpec(root, 'index.qmd').decks, ['lectures/one-slides.qmd'])
})

test('explicitly linked assets survive as relative app-site paths', () => {
  const root = fixture()
  const output = join(root, 'app-output')
  mkdirSync(output)
  const spec = deriveCourseAppSpec(root, 'index.qmd')
  copyCourseAppAssets(root, output, spec)
  const relativeAsset = 'homework/handouts/hw-handout.zip'
  assert.equal(existsSync(join(output, relativeAsset)), true)
  assert.equal(readFileSync(join(output, relativeAsset), 'utf8'), relativeAsset)
})

test('already-built TLDA output is selected, ordered, and repeatable from the declarations', () => {
  const root = fixture()
  writeFileSync(join(root, '_quarto.yml'), 'project:\n  type: tlda\nbook:\n  title: Course\n  chapters:\n    - index.qmd\n    - chapters/one.qmd\n    - homework/hw.qmd\n')
  writeFileSync(join(root, '_quarto-slides.yml'), 'project:\n  type: default\n  render:\n    - decks/one-slides.qmd\n')
  const built = join(root, 'tlda-output')
  const output = join(mkdtempSync(join(tmpdir(), 'course-app-output-')), 'app-site')
  mkdirSync(join(built, '_book/chapters'), { recursive: true })
  mkdirSync(join(built, '_book/decks'), { recursive: true })
  const pages = [
    ['chapters/dormant.qmd', '_book/chapters/dormant.html', 'Dormant'],
    ['index.qmd', '_book/index.html', 'Course'],
    ['decks/one-slides.qmd', '_book/decks/one-slides.html', 'One — Slides'],
    ['chapters/one.qmd', '_book/chapters/one.html', 'One'],
    ['homework/hw.qmd', '_book/homework/hw.html', 'Homework'],
  ].map(([source, file, title]) => ({ file, title, source: { file: source }, ...(source.startsWith('decks/') ? { variant: 'slides' } : {}) }))
  for (const page of pages) {
    mkdirSync(join(built, dirname(page.file)), { recursive: true })
    writeFileSync(join(built, page.file), `<h1>${page.title}</h1>`)
    mkdirSync(join(built, dirname(page.source.file)), { recursive: true })
    writeFileSync(join(built, page.source.file), page.source.file)
  }
  writeFileSync(join(built, '_book/runtime-frame.html'), 'renderer dependency')
  writeFileSync(join(built, 'page-info.json'), JSON.stringify(pages))
  writeFileSync(join(built, 'toc.json'), JSON.stringify(pages.map((page, i) => ({ title: page.title, level: 'chapter', page: i + 1 }))))

  const first = assembleCourseAppSite(root, 'index.qmd', built, output)
  assert.deepEqual(first.pages.map(page => page.source.file), [
    'index.qmd', 'chapters/one.qmd', 'homework/hw.qmd', 'decks/one-slides.qmd',
  ])
  assert.deepEqual(first.pages.map(page => page.file), [
    '_book/index.html', '_book/chapters/one.html', '_book/homework/hw.html', '_book/decks/one-slides.html',
  ])
  assert.equal(existsSync(join(output, '_book/chapters/dormant.html')), false)
  assert.equal(existsSync(join(output, 'chapters/dormant.qmd')), false)
  assert.equal(existsSync(join(output, '_book/chapters/one.html')), true)
  assert.equal(existsSync(join(output, 'chapters/one.qmd')), true)
  assert.equal(existsSync(join(output, '_book/runtime-frame.html')), true)
  const snapshot = readFileSync(join(output, 'page-info.json'), 'utf8')
  assembleCourseAppSite(root, 'index.qmd', built, output)
  assert.equal(readFileSync(join(output, 'page-info.json'), 'utf8'), snapshot)
})

test('every page a declared source generates is a member through its master', () => {
  const root = fixture()
  writeFileSync(join(root, '_quarto.yml'), 'project:\n  type: tlda\nbook:\n  title: Course\n  chapters:\n    - index.qmd\n    - homework/hw.qmd\n')
  writeFileSync(join(root, '_quarto-slides.yml'), 'project:\n  type: default\n')
  writeFileSync(join(root, 'homework/hw.qmd'), '---\ntitle: HW\noutput-file: hw-solutions.html\n---\n')
  const built = join(mkdtempSync(join(tmpdir(), 'course-app-built-')), 'built')
  const output = join(mkdtempSync(join(tmpdir(), 'course-app-output-')), 'app-site')
  mkdirSync(join(built, '_book/homework'), { recursive: true })
  const pages = [
    ['homework/hw.qmd', '_book/homework/hw.html', 'Homework'],
    ['homework/hw.qmd', '_book/homework/hw-solutions.html', 'Homework solutions'],
    ['index.qmd', '_book/index.html', 'Course'],
  ].map(([source, file, title]) => ({ file, title, source: { file: source } }))
  for (const page of pages) {
    mkdirSync(join(built, dirname(page.file)), { recursive: true })
    writeFileSync(join(built, page.file), `<h1>${page.title}</h1>`)
  }
  writeFileSync(join(built, 'page-info.json'), JSON.stringify(pages))
  const { pages: selected } = assembleCourseAppSite(root, 'index.qmd', built, output)
  assert.deepEqual(selected.map(page => page.file), [
    '_book/index.html', '_book/homework/hw.html', '_book/homework/hw-solutions.html',
  ])
  assert.equal(existsSync(join(output, '_book/homework/hw-solutions.html')), true)
})

test('schedule parity merges only the static schedule slice by date', () => {
  const staticHtml = [
    '<html><head><title>Static</title><link rel="stylesheet" href="css/skeleton.css"></head><body>',
    '<div class="row" id="syllabus"><p>FOREIGN SECTION</p></div>',
    '<div class="row" id="schedule"><h4>Tentative Schedule</h4><table><tbody>',
    '<tr><td>Th&nbsp;Aug&nbsp;27,&nbsp;4:00</td><td> <a href="book/chapters/one.html">One</a> </td></tr>',
    '<tr><td>Th&nbsp;Aug&nbsp;27,&nbsp;11:59</td><td> <a href="book/homework/hw.html">HW 1</a> out <a href="book/homework/handouts/hw-handout.zip">[download zip]</a> </td></tr>',
    '<tr><td>T&nbsp;Sep&nbsp;1,&nbsp;4:00</td><td> <a href="book/chapters/missing.html">Missing</a> <a href="decks/one-slides.html">[slides]</a> </td></tr>',
    '</tbody></table></div>',
    '<div class="row" id="practices"><p>FOREIGN PRACTICES</p></div>',
    '</body></html>',
  ].join('\n')
  const row = (date, body) => `<tr><td>${date}</td><td>${body}</td></tr>`
  const appHtml = [
    '<main><section id="schedule"><h2>Schedule</h2><table><tbody>',
    row('Th Aug 27', '<a href="chapters/one.qmd">One</a> · <em>HW 1 out</em>'),
    row('T Sep 1', 'New chapter row'),
    row('F Dec 4', 'App-only later row'),
    '</tbody></table></section></main>',
  ].join('\n')
  const declared = new Set(['chapters/one.html', 'homework/hw.html', 'homework/handouts/hw-handout.zip', 'decks/one-slides.html'])
  const { html, augmented } = mergeStaticScheduleLinks(appHtml, staticHtml, href => declared.has(href))
  assert.equal(augmented, 4)
  assert.equal((html.match(/id=["']schedule["']/g) || []).length, 1)
  assert.match(html, /href="homework\/hw\.html"/)
  assert.match(html, /href="homework\/handouts\/hw-handout\.zip"/)
  assert.match(html, /href="decks\/one-slides\.html"/)
  assert.equal(html.includes('FOREIGN SECTION'), false)
  assert.equal(html.includes('FOREIGN PRACTICES'), false)
  assert.equal(html.includes('<title>Static</title>'), false)
  assert.equal(html.includes('skeleton.css'), false)
  assert.match(html, /App-only later row/)
  assert.equal(html.includes('href="book/chapters/one.html"'), false)
  assert.equal(html.includes('href="chapters/missing.html"'), false)
  assert.match(html, /Missing/)
  assert.equal((html.match(/chapters\/one/g) || []).length, 1)
})

test('schedule parity leaves non-schedule indexes untouched', () => {
  const appHtml = '<main><section id="schedule"><table><tbody><tr><td>T Sep 1</td><td>Row</td></tr></tbody></table></section></main>'
  assert.equal(mergeStaticScheduleLinks(appHtml, '<html><body><p>no static schedule</p></body></html>', () => true).augmented, 0)
  const staticHtml = '<html><body><div class="row" id="schedule"><table><tbody><tr><td>T&nbsp;Sep&nbsp;1</td><td><a href="book/chapters/one.html">One</a></td></tr></tbody></table></div></body></html>'
  assert.equal(mergeStaticScheduleLinks('<main><p>no app schedule</p></main>', staticHtml, () => true).augmented, 0)
  assert.equal(mergeStaticScheduleLinks(appHtml, staticHtml, () => false).html.includes('href="chapters/one.html"'), false)
})
