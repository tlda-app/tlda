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

test('agreement is green, and a difference in text is yellow', () => {
  assert.equal(markForRow({ preview: 'aaa', published: 'aaa' }).mark, 'green')
  assert.equal(markForRow({ preview: 'aaa', published: 'bbb' }).mark, 'yellow')
})

test('written but not on the class site is yellow, and written but nowhere is red', () => {
  assert.equal(markForRow({ preview: 'aaa', published: null }).mark, 'yellow')
  assert.equal(markForRow({ preview: null, published: null }).mark, 'red')
})

// The state his course is actually in tonight: the class site serves five decks
// and eight chapters the current build does not produce. Reading that as
// "behind" would file it under a colour meaning "fine after the next publish",
// which it is not — publishing would remove them.
test('the class site serving what the app cannot produce alarms rather than taking a shade', () => {
  assert.equal(markForRow({ preview: null, published: 'aaa' }).mark, 'alarm')
})

// A network failure is a fact about us. Painting his contents from it would
// make every row yellow the moment GitHub is slow, and yellow means he has
// unpublished work — a claim about his book made out of our outage.
test('a surface nobody could ask leaves the row unmarked', () => {
  assert.equal(markForRow({ preview: 'aaa', published: undefined }).mark, 'unknown')
  assert.equal(markForRow({ preview: undefined, published: 'aaa' }).mark, 'unknown')
})

test('rows keep their identity through the comparison', () => {
  assert.deepEqual(
    marksForRows([{ page: 4, source: 'decks/chapter-bootstrap-slides.qmd', preview: 'aaa', published: 'aaa' }]),
    [{ page: 4, source: 'decks/chapter-bootstrap-slides.qmd', preview: 'aaa', published: 'aaa', mark: 'green', why: 'the app and the class site serve the same text' }],
  )
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
  assert.equal(marks[0].mark, 'unknown', 'an unreachable class site must not repaint the contents')
})

test('the comparison reads 404 as absent and agreeing text as green', async () => {
  const marks = await compareCourseSurfaces([PAGE('app/book/chapters/one.html'), PAGE('app/book/decks/two-slides.html')], {
    readPreview: async () => '<main><p>same prose</p></main>',
    publishedBase: 'https://site.example',
    fetchImpl: async (url) => url.includes('two-slides')
      ? { ok: false, status: 404, text: async () => '' }
      : { ok: true, status: 200, text: async () => '<main><p>same prose</p></main>' },
  })
  assert.deepEqual(marks.map(row => [row.page, row.source, row.mark]), [
    [1, 'chapters/one.qmd', 'green'],
    [2, 'decks/two-slides.qmd', 'yellow'],
  ])
})
