import assert from 'node:assert/strict'
import test from 'node:test'

import { compareCourseSurfaces, documentTextFingerprint, markForRow, marksForRows, publicationPathForPage, publishedUrlForPage } from './course-surface-marks.mjs'

// The real difference between the same chapter on the app's `static/` tree and
// on GitHub Pages, reduced to one paragraph. Every one of these is chrome the
// two builds disagree about, and none of it is prose:
//   - `data-source-line`, stamped by tlda for source mapping
//   - `?v=<ms>` on figure URLs, stamped by the same build
//   - attribute order, which Quarto does not preserve between runs
const APP_COPY = `<html><head><title>x</title></head><body><main>
  <p data-source-line="258">Both of the sampling distributions came to us as a <em>parametric form</em>.</p>
  <img src="fig-1.svg?v=1789788442370" class="img-fluid" id="fig-bootstrap">
  <script>window.MathJax = {}</script>
</main></body></html>`

const PUBLISHED_COPY = `<html><head><title>x</title></head><body><main>
  <p>Both of the sampling distributions came to us as a <em>parametric form</em>.</p>
  <img id="fig-bootstrap" class="img-fluid" src="fig-1.svg">
</main></body></html>`

test('the same prose fingerprints the same through both builds chrome', () => {
  assert.equal(documentTextFingerprint(APP_COPY), documentTextFingerprint(PUBLISHED_COPY))
})

// The control the comparator exists for, and the one it must never miss: a
// changed number in an otherwise identical chapter. Two of his chapters differ
// from what is published at IDENTICAL character counts, so a length check would
// pass both of them.
test('one changed number is a different fingerprint at the same length', () => {
  const edited = PUBLISHED_COPY.replace('parametric', 'parametrik')
  assert.equal(edited.length, PUBLISHED_COPY.length, 'the control must hold length fixed')
  assert.notEqual(documentTextFingerprint(edited), documentTextFingerprint(PUBLISHED_COPY))
})

test('agreement is published, and a difference is preview', () => {
  assert.equal(markForRow({ preview: 'aaa', published: 'aaa' }).stage, 'published')
  assert.equal(markForRow({ preview: 'aaa', published: 'bbb' }).stage, 'preview')
})

// "the app amd static disagreeing is an error state at that stage bro". These
// two were the same value and only one of them is a stage: not yet published is
// behind, while published-and-different is a publish that ran and did not land.
// Splitting them is what tells him which of his pages are merely unpublished
// and which are published wrong.
test('not yet published is behind, and published-but-different is broken', () => {
  const behind = markForRow({ preview: 'aaa', published: null })
  assert.equal(behind.stage, 'preview')
  assert.equal(behind.error, null, 'nothing failed; it simply has not been published')

  const wrong = markForRow({ preview: 'aaa', published: 'bbb' })
  assert.equal(wrong.stage, 'preview', 'the stage is still where the current text has got to')
  assert.ok(wrong.error, 'and publishing did not do its job, which is a failure')
})

test('written but not on the class site is preview, and written but nowhere is here-only', () => {
  assert.equal(markForRow({ preview: 'aaa', published: null }).stage, 'preview')
  assert.equal(markForRow({ preview: null, published: null }).stage, 'here-only')
})

// Skip's correction, and the reason a fifth colour was wrong: error is
// orthogonal to stage. The class site serving a page this build cannot make is
// published AND broken, so it keeps its stage and gains an error rather than
// being moved off the scale.
test('the class site serving what the app cannot produce is published and errored, both', () => {
  const row = markForRow({ preview: null, published: 'aaa' })
  assert.equal(row.stage, 'published')
  assert.ok(row.error, 'and it must carry the error')
})

// "unkown is an error state dude". Saying nothing was the bug that made this
// feature invisible for three weeks: every row was unaskable because no class
// site was configured, so every row drew nothing.
test('a surface nobody could ask has no stage and IS an error', () => {
  for (const row of [markForRow({ preview: 'aaa', published: undefined }), markForRow({ preview: undefined, published: 'aaa' })]) {
    assert.equal(row.stage, null, 'it has no stage, because not-knowing is not a stage')
    assert.ok(row.error, 'and it must say so rather than drawing nothing')
  }
})

test('a row that is fine carries no error at all', () => {
  assert.equal(markForRow({ preview: 'aaa', published: 'aaa' }).error, null)
  assert.equal(markForRow({ preview: 'aaa', published: null }).error, null)
  assert.equal(markForRow({ preview: null, published: null }).error, null)
})

test('rows keep their identity through the comparison', () => {
  const [row] = marksForRows([{ page: 4, source: 'decks/chapter-bootstrap-slides.qmd', preview: 'aaa', published: 'aaa' }])
  assert.equal(row.page, 4)
  assert.equal(row.source, 'decks/chapter-bootstrap-slides.qmd')
  assert.equal(row.stage, 'published')
})

// A real address on the live class site, checked by hand: the deck is `200` at
// `https://qtm285.github.io/static/book/decks/chapter-bootstrap-slides.html`.
test('a built page keeps one path across the publication and the class site', () => {
  assert.equal(publicationPathForPage('app/book/decks/chapter-bootstrap-slides.html'), 'book/decks/chapter-bootstrap-slides.html')
  assert.equal(
    publishedUrlForPage('app/book/decks/chapter-bootstrap-slides.html', 'https://qtm285.github.io/static'),
    'https://qtm285.github.io/static/book/decks/chapter-bootstrap-slides.html',
  )
})

// The `app/` tree answers 200 with the reader shell for any path at all, so a
// comparison addressed there fingerprints the same shell for every row.
test('the compared path is never the reader shell', () => {
  assert.equal(publicationPathForPage('app/book/index.html').includes('app/'), false)
})

const PAGE = (file) => ({ file, source: { file: file.replace(/^app\/book\//, '').replace(/\.html$/, '.qmd') } })

test('a surface that cannot be reached is not reported as a missing page', async () => {
  const marks = await compareCourseSurfaces([PAGE('app/book/chapters/one.html')], {
    readPreview: async () => '<main><p>same prose</p></main>',
    publishedBase: 'https://site.example',
    fetchImpl: async () => Promise.reject(new Error('ENOTFOUND')),
  })
  assert.equal(marks[0].stage, null, 'an unreachable class site must not invent a stage')
  assert.ok(marks[0].error, 'but it must say that it could not be reached')
})

test('the comparison reads 404 as absent and agreeing text as green', async () => {
  const marks = await compareCourseSurfaces([PAGE('app/book/chapters/one.html'), PAGE('app/book/decks/two-slides.html')], {
    readPreview: async () => '<main><p>same prose</p></main>',
    publishedBase: 'https://site.example',
    fetchImpl: async (url) => url.includes('two-slides')
      ? { ok: false, status: 404, text: async () => '' }
      : { ok: true, status: 200, text: async () => '<main><p>same prose</p></main>' },
  })
  assert.deepEqual(marks.map(row => [row.page, row.source, row.stage]), [
    [1, 'chapters/one.qmd', 'published'],
    [2, 'decks/two-slides.qmd', 'preview'],
  ])
})
