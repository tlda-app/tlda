import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assembleCourseAppSite, copyCourseAppAssets, deriveCourseAppSpec } from './course-app-build.mjs'

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

test('an unlinked matching deck is not released', () => {
  const root = fixture()
  writeFileSync(join(root, 'index.qmd'), '[Chapter](chapters/one.qmd)')
  assert.deepEqual(deriveCourseAppSpec(root, 'index.qmd').decks, [])
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

test('already-built TLDA output is selected, ordered, and repeatable from the index', () => {
  const root = fixture()
  const built = join(root, 'tlda-output')
  const output = join(mkdtempSync(join(tmpdir(), 'course-app-output-')), 'app-site')
  mkdirSync(join(built, '_book/chapters'), { recursive: true })
  mkdirSync(join(built, '_book/decks'), { recursive: true })
  const pages = [
    ['chapters/unreleased.qmd', '_book/chapters/unreleased.html', 'Unreleased'],
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
  assert.equal(existsSync(join(output, '_book/chapters/unreleased.html')), false)
  assert.equal(existsSync(join(output, 'chapters/unreleased.qmd')), false)
  assert.equal(existsSync(join(output, '_book/chapters/one.html')), true)
  assert.equal(existsSync(join(output, 'chapters/one.qmd')), true)
  assert.equal(existsSync(join(output, '_book/runtime-frame.html')), true)
  const snapshot = readFileSync(join(output, 'page-info.json'), 'utf8')
  assembleCourseAppSite(root, 'index.qmd', built, output)
  assert.equal(readFileSync(join(output, 'page-info.json'), 'utf8'), snapshot)
})
