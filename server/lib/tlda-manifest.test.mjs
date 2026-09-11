import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'

import { findTldaManifest, findTldaManifests, pageInfoFromTldaManifest } from './tlda-manifest.mjs'

// The plural finder does NOT throw on more than one, because its caller is the
// build that just created the second one and has to know which. `findTldaManifest`
// keeps throwing, because its caller is about to publish and two manifests mean
// it cannot know which document it is publishing.
test('every manifest is listed, and only the singular finder refuses two', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-find-manifests-'))
  try {
    mkdirSync(join(root, '_book'), { recursive: true })
    writeFileSync(join(root, '_book', 'tlda-manifest.json'), '{}')
    assert.deepEqual(findTldaManifests(root).map((path) => relative(root, path)), ['_book/tlda-manifest.json'])
    assert.equal(relative(root, findTldaManifest(root)), '_book/tlda-manifest.json')

    writeFileSync(join(root, 'tlda-manifest.json'), '{}')
    assert.deepEqual(
      findTldaManifests(root).map((path) => relative(root, path)).sort(),
      ['_book/tlda-manifest.json', 'tlda-manifest.json'],
    )
    assert.throws(() => findTldaManifest(root), /Multiple tlda-manifest\.json/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a tree with no manifest lists none and resolves to null', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-find-manifests-none-'))
  try {
    assert.deepEqual(findTldaManifests(root), [])
    assert.equal(findTldaManifest(root), null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('maps the version 1 tlda manifest to ordered page info', () => {
  const pages = pageInfoFromTldaManifest({
    version: 1,
    kind: 'tlda',
    pages: [
      {
        file: 'chapter.html',
        title: 'Chapter',
        source: { type: 'project-source', format: 'qmd', file: 'chapter.qmd' },
      },
      {
        file: 'index.html',
        title: 'Introduction',
        source: { type: 'project-source', format: 'qmd', file: 'index.qmd' },
      },
    ],
  }, { prefix: '_book' })

  assert.deepEqual(pages.map(page => page.file), ['_book/chapter.html', '_book/index.html'])
  assert.deepEqual(pages[0], {
    file: '_book/chapter.html',
    width: 800,
    height: 1200,
    title: 'Chapter',
    format: 'qmd',
    source: { type: 'project-source', format: 'qmd', file: 'chapter.qmd' },
  })
})

test('rejects paths that escape the rendered project', () => {
  assert.throws(() => pageInfoFromTldaManifest({
    version: 1,
    kind: 'tlda',
    pages: [{
      file: '../outside.html',
      title: 'Outside',
      source: { type: 'project-source', format: 'qmd', file: 'outside.qmd' },
    }],
  }), /must stay inside the project/)
})
