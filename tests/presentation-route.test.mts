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
