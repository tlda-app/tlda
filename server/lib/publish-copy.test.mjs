import test from 'node:test'
import assert from 'node:assert/strict'

import { canvasPagesFromTheirStaticTwins } from './publish-copy.mjs'

const file = (path, sha256) => ({ path, sha256, size: 1 })

test('a canvas file with an identical twin is copied, not fetched', () => {
  const { derive, fetchable, disagree } = canvasPagesFromTheirStaticTwins([
    file('static/book/a.html', 'aaa'), file('app/book/a.html', 'aaa'),
    file('static/book/fig.svg', 'bbb'), file('app/book/fig.svg', 'bbb'),
  ])
  assert.deepEqual(derive, [
    { from: 'static/book/a.html', to: 'app/book/a.html' },
    { from: 'static/book/fig.svg', to: 'app/book/fig.svg' },
  ])
  assert.deepEqual(fetchable.map(f => f.path), ['static/book/a.html', 'static/book/fig.svg'])
  assert.deepEqual(disagree, [])
})

test('a canvas file with no twin is fetched when it can be, refused when it cannot', () => {
  const { fetchable, disagree } = canvasPagesFromTheirStaticTwins([
    file('app/course-app-spec.json', 'ccc'),
    file('app/book/own.html', 'ddd'),
  ])
  assert.deepEqual(fetchable.map(f => f.path), ['app/course-app-spec.json'])
  assert.equal(disagree.length, 1)
  assert.match(disagree[0].why, /no file of that name/)
})

test('a canvas page whose twin disagrees is refused rather than guessed at', () => {
  const { derive, disagree } = canvasPagesFromTheirStaticTwins([
    file('static/book/a.html', 'aaa'), file('app/book/a.html', 'zzz'),
  ])
  assert.deepEqual(derive, [])
  assert.equal(disagree.length, 1)
  assert.match(disagree[0].why, /aaa.*zzz|zzz/)
})

test('the static half is never derived from itself', () => {
  const { derive, fetchable } = canvasPagesFromTheirStaticTwins([file('static/book/a.html', 'aaa')])
  assert.deepEqual(derive, [])
  assert.deepEqual(fetchable.map(f => f.path), ['static/book/a.html'])
})
