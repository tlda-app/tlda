import assert from 'node:assert/strict'
import test from 'node:test'
import { offlineDocumentUrls } from '../src/airplaneMode'

test('Airplane mode enumerates every target page in a multi-target SVG project', () => {
  assert.deepEqual(offlineDocumentUrls(
    { projectName: 'paper', basePath: '/docs/paper/' },
    { projectName: 'paper', basePath: '/docs/paper/', format: 'svg', targets: [
      { texBase: 'main', pages: 2 },
      { texBase: 'appendix', pages: 1 },
    ] },
  ), [
    '/docs/paper/main-page-1.svg',
    '/docs/paper/main-page-2.svg',
    '/docs/paper/appendix-page-1.svg',
  ])
})

test('Airplane mode enumerates every rendered HTML document page', () => {
  assert.deepEqual(offlineDocumentUrls(
    { projectName: 'chapter', basePath: '/docs/chapter/', format: 'qmd' },
    { projectName: 'chapter', basePath: '/docs/chapter/', format: 'qmd', pageInfo: [
      { file: 'index.html' },
      { file: 'exercise.html' },
    ] },
  ), ['/docs/chapter/index.html', '/docs/chapter/exercise.html'])
})
