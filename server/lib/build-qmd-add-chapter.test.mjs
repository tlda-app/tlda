import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  joinRenderedButUnmanifestedChapters,
  quartoBookToc,
} from './incremental-qmd-build.mjs'

const seedPages = [
  { file: '_book/index.html', title: 'Course', source: { type: 'project-source', format: 'qmd', file: 'index.qmd' } },
  { file: '_book/chapters/models.html', title: 'Models', source: { type: 'project-source', format: 'qmd', file: 'chapters/chapter-models.qmd' } },
]

function fixture({ withRender }) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-add-chapter-'))
  mkdirSync(join(root, '_book', 'chapters'), { recursive: true })
  mkdirSync(join(root, 'chapters'), { recursive: true })
  writeFileSync(join(root, '_quarto.yml'), [
    'project:',
    '  type: tlda',
    'book:',
    '  chapters:',
    '    - index.qmd',
    '    - chapters/chapter-models.qmd',
    '    - chapters/chapter-probe.qmd',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'index.qmd'), '# Course\n')
  writeFileSync(join(root, 'chapters/chapter-models.qmd'), '# Models\n')
  writeFileSync(join(root, 'chapters/chapter-probe.qmd'), '# Probe\n\nProbe content.\n')
  writeFileSync(join(root, '_book', 'index.html'), '<!DOCTYPE html><html><head><title>Course</title></head><body><h1 class="title">Course</h1></body></html>\n')
  writeFileSync(join(root, '_book', 'chapters/models.html'), '<!DOCTYPE html><html><head><title>Models</title></head><body><h1 class="title">Models</h1></body></html>\n')
  if (withRender) {
    writeFileSync(join(root, '_book', 'chapters/chapter-probe.html'), '<!DOCTYPE html><html><head><title>Probe</title></head><body><h1 class="title">Probe</h1></body></html>\n')
  }
  return root
}

// A component render never rewrites the manifest, so a newly declared chapter
// the pass just wrote has no manifest row. Without the join, the ToC build
// throws on a render that already succeeded and already wrote the page.
test('a newly declared chapter with a render joins the seeded pages in declared order', () => {
  const root = fixture({ withRender: true })
  try {
    const joined = joinRenderedButUnmanifestedChapters(root, seedPages, join(root, '_book'))
    assert.deepEqual(
      joined.map(page => page.source.file),
      ['index.qmd', 'chapters/chapter-models.qmd', 'chapters/chapter-probe.qmd'],
      'the new chapter must join at its declared position',
    )
    const probe = joined.find(page => page.source.file === 'chapters/chapter-probe.qmd')
    assert.equal(probe.file, '_book/chapters/chapter-probe.html')
    assert.equal(probe.title, 'Probe')
    const toc = quartoBookToc(root, joined)
    assert.deepEqual(toc.map(entry => entry.title), ['Course', 'Models', 'Probe'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// The join only covers what the pass rendered. A declared chapter with no
// render still fails loudly at the ToC, which is the missing-chapter signal,
// not a page to invent.
test('a declared chapter with no render still fails the ToC loudly', () => {
  const root = fixture({ withRender: false })
  try {
    const joined = joinRenderedButUnmanifestedChapters(root, seedPages, join(root, '_book'))
    assert.deepEqual(joined.map(page => page.source.file), ['index.qmd', 'chapters/chapter-models.qmd'])
    assert.throws(() => quartoBookToc(root, joined), /did not produce it/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Seeded pages pass through untouched: no reordering, no retitling, no refill
// of chapters the manifest already names.
test('seeded chapters pass through the join untouched', () => {
  const root = fixture({ withRender: true })
  try {
    const joined = joinRenderedButUnmanifestedChapters(root, seedPages, join(root, '_book'))
    assert.deepEqual(joined.slice(0, 2), seedPages)
    assert.equal(readFileSync(join(root, '_book', 'chapters/models.html'), 'utf8').includes('Models'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
