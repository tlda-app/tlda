import assert from 'node:assert/strict'
import test from 'node:test'

import { compareCourseSurfaces, documentTextFingerprint, markForRow, marksForRows, pageBuildCurrency, publicationPathForPage, publishedBaseFromCourse, publishedUrlForPage } from './course-surface-marks.mjs'

// The real difference between the same chapter on the app's `static/` tree and
// on GitHub Pages, reduced to one paragraph. Every one of these is chrome the
// two builds disagree about, and none of it is prose:
//   - `data-source-line`, stamped by tlda for source mapping
//   - `?v=<ms>` on figure URLs, stamped by the same build
//   - attribute order, which Quarto does not preserve between runs
const APP_COPY = `<html><head><title>x</title></head><body><main>
  <p data-source-line="258">Both of the sampling distributions came to us as a <em>parametric form</em>.</p>
  <img src="fig-1.svg?v=1789788442370" class="img-fluid" id="fig-bootstrap">
  <script>window.katex = {}</script>
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

// A publish the command declined to attempt is not one nobody ran. The refused
// reason triangles like a failure — it names something only he can settle —
// and says "refused" rather than "failed" so the two do not read alike.
test('a refused publish triangles with the refusal reason', () => {
  const mark = markForRow({ app: 'a', preview: 'a', live: 'b', failure: 'publish refused: "book" is building right now' })
  assert.equal(mark.stage, 'preview', 'it got to preview, so the attempt that failed was the next one')
  assert.equal(mark.errorAt, 'live')
  assert.match(mark.error, /refused/)
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
    target: 'qtm285.github.io',
  })
  assert.equal(marks[0].stage, null, 'an unreachable published site must not invent a stage')
  assert.match(marks[0].error, /qtm285\.github\.io/, 'and it must name the target it compared, not "the class site"')
  assert.match(marks[0].error, /ENOTFOUND/, 'and carry why it could not be asked')
})

// "could not be asked" was the identical sentence for a field nobody had set
// and for a host the server cannot resolve. Separating those cost three
// measurements and a probe from inside the app machine on 2026-09-20, so the
// two must not read alike.
test('an unset address and an unreachable host do not produce the same sentence', async () => {
  const withoutAddress = await compareCourseSurfaces([PAGE('app/book/chapters/one.html')], {
    readApp: async () => '<main><p>same prose</p></main>',
    readPreview: async () => '<main><p>same prose</p></main>',
    publishedBase: null,
    fetchImpl: async () => { throw new Error('should not be called') },
  })
  const unreachable = await compareCourseSurfaces([PAGE('app/book/chapters/one.html')], {
    readApp: async () => '<main><p>same prose</p></main>',
    readPreview: async () => '<main><p>same prose</p></main>',
    publishedBase: 'https://site.example',
    fetchImpl: async () => Promise.reject(new Error('ENOTFOUND')),
  })
  // REVISED 2026-09-20. This used to assert that an unset address says "no
  // address configured". Skip, seeing that on his own project: "if there is no
  // preview or publish destination, why would i be troubled by that. that's
  // most projects" — and the instruction, "on projects with no preview target,
  // disable the preview related checks/ui; similarly with publish".
  //
  // So the two are still distinguishable, which is what this test is for, but
  // the distinction is now silence versus a named failure rather than two
  // different complaints. A destination nobody configured says NOTHING.
  assert.equal(withoutAddress[0].error, null)
  // And the calm sentence must not name the missing destination either: "on
  // preview, not yet on the published site" tells the reader a step remains
  // when there is no such step. With nowhere to publish, preview is arrival.
  assert.equal(withoutAddress[0].why, 'on preview')
  assert.match(unreachable[0].error, /ENOTFOUND/)
  assert.notEqual(withoutAddress[0].error, unreachable[0].error)
})

test('a project with neither destination is asked about neither, and says nothing', async () => {
  // The whole of his complaint, in one row: most projects have no preview and
  // no publication, and they were wearing an error about failing to reach both.
  //
  // The `fetchImpl` and `readPreview` throws are the control for "disable the
  // CHECKS, not just the message" — if either destination were still probed,
  // this test fails with that error rather than passing quietly.
  const rows = await compareCourseSurfaces([PAGE('app/book/chapters/one.html')], {
    readApp: async () => '<main><p>same prose</p></main>',
    readPreview: async () => { throw new Error('preview must not be asked') },
    publishedBase: null,
    previewConfigured: false,
    fetchImpl: async () => { throw new Error('the published site must not be asked') },
  })
  assert.equal(rows[0].error, null)
  assert.equal(rows[0].why, null)
  assert.equal(rows[0].stage, null)
  assert.equal(rows[0].destinations, false)
})

test('a preview with no publication reaches preview, and never claims published', async () => {
  // The lie worth refusing: with nowhere to publish, "published" would be a
  // green mark for a place that does not exist. Preview is the furthest real
  // stage, so the chain ends there.
  const rows = await compareCourseSurfaces([PAGE('app/book/chapters/one.html')], {
    readApp: async () => '<main><p>same prose</p></main>',
    readPreview: async () => '<main><p>same prose</p></main>',
    publishedBase: null,
    fetchImpl: async () => { throw new Error('the published site must not be asked') },
  })
  assert.equal(rows[0].stage, 'preview')
  assert.equal(rows[0].error, null)
})

// One row's failure must not be reported against another's.
test('a reason belongs to the row that produced it', async () => {
  const marks = await compareCourseSurfaces(
    [PAGE('app/book/chapters/one.html'), PAGE('app/book/chapters/two.html')], {
      readApp: async () => '<main><p>same prose</p></main>',
      readPreview: async () => '<main><p>same prose</p></main>',
      publishedBase: 'https://site.example',
      fetchImpl: async url => url.includes('two')
        ? Promise.reject(new Error('ENOTFOUND'))
        : { ok: true, status: 200, text: async () => '<main><p>same prose</p></main>' },
    })
  assert.equal(marks[0].stage, 'published', 'the row that answered is unaffected')
  assert.equal(marks[0].error, null)
  assert.match(marks[1].error, /ENOTFOUND/, 'and only the failing row carries the reason')
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

// Derived from the course, never carried as a second field. The marks needed a
// field only one person had ever set, so every other course had none and drew
// nothing — which is the mechanism that hid this work for three weeks. A course
// that publishes somewhere already knows where.
test('where a course publishes comes from the course itself', () => {
  assert.equal(
    publishedBaseFromCourse({ publication: { url: 'https://qtm285.github.io/pages-topology-test/' } }),
    'https://qtm285.github.io/pages-topology-test/static',
  )
  // Measured on both sites: the publication root is a redirect stub to
  // `static/`, and `<publication.url>/static/book/index.html` answers 200 on the
  // class site and on the test site, with an invented filename 404ing.
  assert.equal(
    publishedBaseFromCourse({ publication: { url: 'https://qtm285.github.io' } }),
    'https://qtm285.github.io/static',
  )
})

// Absent means nobody has said where this publishes, and then every row reports
// that the class site could not be asked. That is true, and it is the state
// that used to draw nothing at all.
test('a course naming no publication has no published base, rather than a guessed one', () => {
  assert.equal(publishedBaseFromCourse(null), null)
  assert.equal(publishedBaseFromCourse({}), null)
  assert.equal(publishedBaseFromCourse({ publication: {} }), null)
  assert.equal(publishedUrlForPage('app/book/index.html', null), null)
})

// The build side of the same question. A wrong verdict here is the failure this
// exists to catch and the one nobody sees: a page older than its source served
// as though it were current is what put withheld answers in front of a class.

test('a render older than the source it came from is stale, by the gap between them', () => {
  const edited = Date.parse('2026-09-19T11:47:00Z')
  const rendered = Date.parse('2026-09-19T07:01:00Z')
  assert.deepEqual(pageBuildCurrency({ sourceEditedAt: edited, renderedAt: rendered }), {
    currency: 'stale',
    behindMs: edited - rendered,
    flipMs: null,
  })
})

test('a render that followed the edit carries the turnaround and no staleness', () => {
  const edited = Date.parse('2026-09-19T11:47:00Z')
  const rendered = edited + 61_000
  assert.deepEqual(pageBuildCurrency({ sourceEditedAt: edited, renderedAt: rendered }), {
    currency: 'current',
    behindMs: null,
    flipMs: 61_000,
  })
})

test('a page nothing has rendered is unrendered, not current', () => {
  assert.equal(pageBuildCurrency({ sourceEditedAt: Date.now(), renderedAt: null }).currency, 'unrendered')
})

// The distinction the marks above turn on, kept here too: not knowing is its own
// answer and must never arrive as good news. A rendered page whose source cannot
// be found is not evidence that the render is current.
test('a render with no source to compare is unknown rather than current', () => {
  assert.deepEqual(pageBuildCurrency({ sourceEditedAt: null, renderedAt: Date.now() }), {
    currency: 'unknown',
    behindMs: null,
    flipMs: null,
  })
})
