import assert from 'node:assert/strict'
import test from 'node:test'

import { presentationLocationMatchesPage, presentationPath, presentationRoute } from '../src/presentationRoute.ts'

test('presentation paths carry the same project and course location in either mode', () => {
  const route = presentationRoute('/app/qtm285-book/chapters/chapter-bootstrap.qmd')
  assert.deepEqual(route, {
    mode: 'app',
    project: 'qtm285-book',
    location: 'chapters/chapter-bootstrap.qmd',
    prefix: 'root',
  })
  assert.ok(route)
  assert.equal(presentationPath('static', route.project, route.location), '/static/qtm285-book/chapters/chapter-bootstrap.qmd')
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
  assert.equal(presentationPath('app', 'course one', 'week 1/intro.qmd'), '/app/course%20one/week%201/intro.qmd')
  assert.equal(presentationRoute('/app/course/%ZZ'), null)
  assert.equal(presentationRoute('/docs/course/index.html'), null)
})

test('a published app location selects its matching TLDA canvas page', () => {
  assert.equal(presentationLocationMatchesPage(
    'book/chapters/chapter-bootstrap.html',
    'chapters/chapter-bootstrap.qmd',
    '/docs/qtm285-book/app/book/chapters/chapter-bootstrap.html',
  ), true)
  assert.equal(presentationLocationMatchesPage(
    'book/chapters/chapter-bootstrap.html',
    'chapters/chapter-social-pressure-experiment.qmd',
    '/docs/qtm285-book/app/book/chapters/chapter-social-pressure-experiment.html',
  ), false)
})
