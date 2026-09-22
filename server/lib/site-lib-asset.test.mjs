import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolvePublishedAssetPath, siteLibAssetCandidates } from './site-lib-asset.mjs'

test('nested deck assets fall back to the nearest publication site_libs', () => {
  assert.deepEqual(
    siteLibAssetCandidates('app/book/decks/site_libs/quarto-contrib/live-runtime/qtm285-shared.data.gz'),
    [
      'app/book/decks/site_libs/quarto-contrib/live-runtime/qtm285-shared.data.gz',
      'app/book/site_libs/quarto-contrib/live-runtime/qtm285-shared.data.gz',
      'app/site_libs/quarto-contrib/live-runtime/qtm285-shared.data.gz',
      'site_libs/quarto-contrib/live-runtime/qtm285-shared.data.gz',
    ],
  )
})

test('chapter and static asset paths keep their exact path first', () => {
  assert.deepEqual(siteLibAssetCandidates('app/book/site_libs/quarto-html/quarto.js').slice(0, 2), [
    'app/book/site_libs/quarto-html/quarto.js',
    'app/site_libs/quarto-html/quarto.js',
  ])
  assert.deepEqual(siteLibAssetCandidates('static/book/site_libs/quarto-html/quarto.js').slice(0, 2), [
    'static/book/site_libs/quarto-html/quarto.js',
    'static/site_libs/quarto-html/quarto.js',
  ])
  assert.deepEqual(siteLibAssetCandidates('app/book/figures/plot.png'), ['app/book/figures/plot.png'])
})

test('nested deck request resolves to the existing book asset without changing exact chapter/static assets', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'tlda-site-lib-'))
  const canonicalOutputRoot = await realpath(outputRoot)
  const paths = [
    'app/book/site_libs/runtime/shared.data.gz',
    'static/book/site_libs/runtime/app.js',
  ]
  for (const file of paths) {
    await mkdir(join(outputRoot, file, '..'), { recursive: true })
    await writeFile(join(outputRoot, file), file)
  }

  assert.equal(
    await resolvePublishedAssetPath(outputRoot, 'app/book/decks/site_libs/runtime/shared.data.gz'),
    join(canonicalOutputRoot, 'app/book/site_libs/runtime/shared.data.gz'),
  )
  assert.equal(
    await resolvePublishedAssetPath(outputRoot, 'app/book/site_libs/runtime/shared.data.gz'),
    join(canonicalOutputRoot, 'app/book/site_libs/runtime/shared.data.gz'),
  )
  assert.equal(
    await resolvePublishedAssetPath(outputRoot, 'static/book/site_libs/runtime/app.js'),
    join(canonicalOutputRoot, 'static/book/site_libs/runtime/app.js'),
  )
})
