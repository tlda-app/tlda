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

// The word doing the work is CURRENT. Stale content on live is not arrival: he
// does not care what is on live if it is not what he wrote, so a class site
// serving an old page is yellow — the current thing is on preview — and not
// green-with-a-problem.
test('the colour is how far the CURRENT version has got', () => {
  assert.equal(markForRow({ app: 'a', preview: 'a', live: 'a' }).stage, 'published')
  assert.equal(markForRow({ app: 'a', preview: 'a', live: 'b' }).stage, 'preview', 'live holding the old page is not arrival')
  assert.equal(markForRow({ app: 'a', preview: 'a', live: null }).stage, 'preview')
  assert.equal(markForRow({ app: 'a', preview: 'b', live: 'b' }).stage, 'here-only', 'the current text has not reached preview')
  assert.equal(markForRow({ app: 'a', preview: null, live: null }).stage, 'here-only')
})

// "not on preview because its like, just changed and hasnt made it over the
// network red no triangle". In-flight is not an error, slow is not an error,
// absent is not an error. He edits constantly, so a triangle on every page in
// transit would cry wolf until he stopped reading the column — which is how
// these marks became unreadable the first time.
// "its mot an error until you know there is an error". Ambiguity is a reason to
// try, not a failure — and he edits constantly, so triangling every row that is
// merely behind would put a column of errors in front of him nearly always,
// until he stopped reading it. That is how this went invisible the first time.
test('nothing derives a triangle from absence, staleness or being behind', () => {
  for (const row of [
    { app: 'a', preview: 'b', live: 'b' },
    { app: 'a', preview: null, live: null },
    { app: 'a', preview: 'a', live: null },
    { app: 'a', preview: 'a', live: 'b' },
  ]) {
    const mark = markForRow(row)
    assert.equal(mark.error, null, `${JSON.stringify(row)} is behind, and behind is not broken`)
    assert.equal(mark.errorAt, null)
  }
})

// "try failed → now you know". Only a known outcome makes a triangle, and it is
// named at the link the attempt was trying to cross.
test('a known failure makes the triangle, at the link it happened on', () => {
  const render = markForRow({ app: 'a', preview: 'b', live: 'b', failure: 'chapter.qmd failed to render' })
  assert.equal(render.stage, 'here-only')
  assert.equal(render.errorAt, 'preview')

  const publish = markForRow({ app: 'a', preview: 'a', live: 'b', failure: 'the publish exited non-zero' })
  assert.equal(publish.stage, 'preview')
  assert.equal(publish.errorAt, 'live', 'it got to preview, so the attempt that failed was the next one')
})

// "unkown is an error state dude" — and now it can say WHICH surface, rather
// than only that one could not be reached.
test('a surface nobody could ask has no stage and names itself', () => {
  const mark = markForRow({ app: 'a', preview: undefined, live: 'a' })
  assert.equal(mark.stage, null, 'we cannot say how far it got')
  assert.match(mark.error, /preview could not be asked/)
})

test('rows keep their identity through the comparison', () => {
  const [row] = marksForRows([{ page: 4, source: 'decks/chapter-bootstrap-slides.qmd', app: 'a', preview: 'a', live: 'a' }])
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
    readApp: async () => '<main><p>same prose</p></main>',
    readPreview: async () => '<main><p>same prose</p></main>',
    publishedBase: 'https://site.example',
    fetchImpl: async () => Promise.reject(new Error('ENOTFOUND')),
  })
  assert.equal(marks[0].stage, null, 'an unreachable class site must not invent a stage')
  assert.match(marks[0].error, /the class site could not be asked/, 'and it must name which surface')
})

test('the comparison reads 404 as absent, and agreement all the way as published', async () => {
  const marks = await compareCourseSurfaces([PAGE('app/book/chapters/one.html'), PAGE('app/book/decks/two-slides.html')], {
    readApp: async () => '<main><p>same prose</p></main>',
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
