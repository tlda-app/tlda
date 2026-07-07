import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  htmlPageFileFromUrl,
  htmlPageUrlMatchesTargetFile,
  htmlPageReloadUrl,
} from '../src/html-page-navigation-helpers.ts'

test('htmlPageReloadUrl preserves query and hash while replacing reload token', () => {
  assert.equal(
    htmlPageReloadUrl('/docs/demo/index.html?x=1#section', 1234),
    '/docs/demo/index.html?x=1&_tldaReload=1234#section',
  )
  assert.equal(
    htmlPageReloadUrl('/docs/demo/index.html?_tldaReload=1', 5678),
    '/docs/demo/index.html?_tldaReload=5678',
  )
})

test('htmlPageFileFromUrl maps project-local URLs back to page-info file keys', () => {
  assert.equal(
    htmlPageFileFromUrl(
      '/docs/book/chapter%201.html?_tldaReload=5#intro',
      '/docs/book/',
      'https://tlda.example/docs/book/index.html',
    ),
    'chapter 1.html',
  )
  assert.equal(
    htmlPageFileFromUrl(
      'https://cdn.example/assets/page.html',
      '/docs/book/',
      'https://tlda.example/docs/book/index.html',
    ),
    'assets/page.html',
  )
})

test('htmlPageUrlMatchesTargetFile resolves markdown links to generated html pages', () => {
  assert.equal(
    htmlPageUrlMatchesTargetFile('/docs/world/parts/77777777.html?_tldaShape=shape:a#agent-report', 'parts/77777777.md'),
    true,
  )
  assert.equal(
    htmlPageUrlMatchesTargetFile('/docs/world/parts/77777777.html', '77777777.html'),
    true,
  )
  assert.equal(
    htmlPageUrlMatchesTargetFile('/docs/world/parts/77777777.html', 'other.md'),
    false,
  )
})
