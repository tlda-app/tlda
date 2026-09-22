import assert from 'node:assert/strict'
import test from 'node:test'

import { presentationLocationMatchesPage, presentationPath, presentationRoute } from '../src/presentationRoute.ts'

test('flat presentation paths switch the app/static segment in place', () => {
  const route = presentationRoute('/app/book/chapters/chapter-bootstrap.html')
  assert.deepEqual(route, {
    mode: 'app',
    project: '',
    location: 'book/chapters/chapter-bootstrap.html',
    prefix: 'root',
  })
  assert.ok(route)
  assert.equal(presentationPath('static', route.project, route.location), '/static/book/chapters/chapter-bootstrap.html')
})

test('published artifact paths switch the app/static segment in place', () => {
  const route = presentationRoute('/docs/qtm285-book/static/book/chapters/chapter-bootstrap.html')
  assert.deepEqual(route, {
    mode: 'static',
    project: 'qtm285-book',
    location: 'book/chapters/chapter-bootstrap.html',
    prefix: 'docs',
  })
  assert.ok(route)
  assert.equal(
    presentationPath('app', route.project, route.location, route.prefix),
    '/docs/qtm285-book/app/book/chapters/chapter-bootstrap.html',
  )
})

test('presentation paths encode individual segments and reject malformed escapes', () => {
  assert.equal(presentationPath('app', '', 'course one/week 1/intro.qmd'), '/app/course%20one/week%201/intro.qmd')
  assert.equal(presentationRoute('/app/course/%ZZ'), null)
  assert.equal(presentationRoute('/docs/course/index.html'), null)
  assert.equal(presentationRoute('/app'), null)
  assert.equal(presentationRoute('/static'), null)
})

test('a published app location selects its matching TLDA canvas page', () => {
  assert.equal(presentationLocationMatchesPage(
    presentationRoute('/docs/qtm285-book/app/book/chapters/chapter-bootstrap.html')!,
    'chapters/chapter-bootstrap.qmd',
    '/docs/qtm285-book/app/book/chapters/chapter-bootstrap.html',
  ), true)
  assert.equal(presentationLocationMatchesPage(
    presentationRoute('/docs/qtm285-book/app/book/chapters/chapter-bootstrap.html')!,
    'chapters/chapter-social-pressure-experiment.qmd',
    '/docs/qtm285-book/app/book/chapters/chapter-social-pressure-experiment.html',
  ), false)
})

test('a root App route selects the copied page beneath its project segment', () => {
  const route = presentationRoute('/app/book/chapters/chapter-sampling.html')!
  assert.equal(presentationLocationMatchesPage(
    route,
    'chapters/chapter-sampling.qmd',
    '/app/book/chapters/chapter-sampling.html',
  ), true)
})

test('camera source paths still match outside App routes', () => {
  assert.equal(presentationLocationMatchesPage(
    'chapters/chapter-sampling.qmd',
    'chapters/chapter-sampling.qmd',
    '/docs/qtm285-book/book/chapters/chapter-sampling.html',
  ), true)
})

test('a deck location resolves to the deck page number, not its chapter', async () => {
  const { routedAppPageNumber } = await import('../src/routedAppPageNumber.ts')
  const route = presentationRoute('/docs/qtm285-book/app/book/decks/chapter-random-variables-and-moments-slides.html')!
  // Live page-info shape: deck entries carry no source.file, only the file +
  // query page.src the loader builds. Chapter and deck share tldrawPageId.
  const pages = [
    { src: 'https://tlda-fly.cormorant-matrix.ts.net/docs/qtm285-book/app/book/chapters/chapter-random-variables-and-moments.html', source: { file: 'chapters/chapter-random-variables-and-moments.qmd' } },
    { src: 'https://tlda-fly.cormorant-matrix.ts.net/docs/qtm285-book/app/book/decks/chapter-random-variables-and-moments-slides.html?_tldaDeck=1&view=scroll' },
  ]
  assert.equal(routedAppPageNumber(route, pages), 2)
})

test('the deck chip pairs by chapterRoot, on part rows as well as chapters', async () => {
  const { deckNavIndex } = await import('../src/routedAppPageNumber.ts')
  const rows = [
    // The live defect shape: the Welcome deck hangs off a `part` row, and the
    // old `h.level === 'chapter'` gate made it structurally chipless.
    { level: 'part', page: 1, chapterRoot: 'index.qmd' },
    { level: 'section', page: 5, deckOf: 'index.qmd' },
    { level: 'chapter', page: 2, chapterRoot: 'chapters/chapter-sampling.qmd' },
    { level: 'section', page: 6, deckOf: 'chapters/chapter-sampling.qmd' },
    // Undeclared/unpaired: same title words, no `deckOf` — never a chip.
    { level: 'chapter', page: 3, chapterRoot: 'chapters/chapter-telephone.qmd' },
    { level: 'section', page: 7, deckOf: 'decks/adjusted-comparisons-slides.qmd' },
  ]
  assert.equal(deckNavIndex(rows, 0), 1)
  assert.equal(deckNavIndex(rows, 2), 3)
  assert.equal(deckNavIndex(rows, 4), null)
})

test('the deck pairing derives from live page-info when toc.json predates it', async () => {
  const { deckNavIndex, enrichTocWithPageInfo } = await import('../src/routedAppPageNumber.ts')
  const { readFileSync } = await import('node:fs')
  // The exact live defect shape: served `toc.json` carries only
  // title/level/page, while the same surface's `page-info.json` carries the
  // pairing (`map`, `variant: 'slides'`). No title parsing, no reorder.
  const toc = JSON.parse(readFileSync(new URL('./fixtures/live-qtm285-toc.json', import.meta.url), 'utf8'))
  const pages = JSON.parse(readFileSync(new URL('./fixtures/live-qtm285-page-info.json', import.meta.url), 'utf8'))
  const bareKeys = new Set(toc.flatMap((row: object) => Object.keys(row)))
  assert.deepEqual([...bareKeys].sort(), ['level', 'page', 'title'])
  const bare = (toc as Array<{ level: string; page: number }>).map(({ level, page }) => ({ level, page }))
  assert.ok(bare.every(row => deckNavIndex(bare, bare.indexOf(row)) === null))
  const enriched = enrichTocWithPageInfo(bare, pages)
  assert.equal(
    enriched.filter((row, i) => deckNavIndex(enriched, i) !== null).length,
    6,
  )
  for (let i = 0; i < enriched.length; i++) {
    const idx = deckNavIndex(enriched, i)
    if (idx == null) continue
    assert.equal(enriched[idx].deckOf, enriched[i].chapterRoot)
  }
  // Order and pages are untouched — only pairing fields are added.
  assert.deepEqual(enriched.map(row => row.page), toc.map((row: { page: number }) => row.page))
  assert.deepEqual(enriched.map(row => row.level), toc.map((row: { level: string }) => row.level))
})
