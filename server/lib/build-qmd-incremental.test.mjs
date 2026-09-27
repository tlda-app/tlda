import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { changedFilesWithSeedFallback, clearQmdFreeze, publishIncrementalQmdOutput, qmdIncrementalRenderRoots } from './build-qmd.mjs'
import { isQuartoConfigFile, qmdDocumentsStaleByDependency, qmdFreshPageSources, qmdUnplacedChangedFiles } from './incremental-qmd-build.mjs'

test('a direct book-component edit selects only that component', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-incremental-test-'))
  try {
    mkdirSync(join(root, '_book'), { recursive: true })
    writeFileSync(join(root, '_book', 'tlda-manifest.json'), '{"version":1,"kind":"tlda","pages":[]}\n')
    writeFileSync(join(root, '_quarto.yml'), `book:\n  chapters:\n    - part: index.qmd\n      chapters:\n        - lectures/chapter-calibration-binary.qmd\n        - lectures/other.qmd\n`)
    writeFileSync(join(root, '_quarto-slides.yml'), `project:\n  render:\n    - lectures/chapter-calibration-binary-slides.qmd\n`)
    mkdirSync(join(root, 'lectures'), { recursive: true })
    writeFileSync(join(root, 'lectures', 'chapter-calibration-binary-slides.qmd'), '# deck\n')
    assert.deepEqual(qmdIncrementalRenderRoots(root, ['lectures/chapter-calibration-binary.qmd']), ['lectures/chapter-calibration-binary.qmd'])
    assert.deepEqual(qmdIncrementalRenderRoots(root, ['lectures/chapter-calibration-binary-slides.qmd']), ['lectures/chapter-calibration-binary-slides.qmd'])
    // Resolved-empty, not unknown: nothing reads it, so nothing renders and
    // the caller syncs it as an artifact instead of widening to the book.
    assert.deepEqual(qmdIncrementalRenderRoots(root, ['shared-code.qmd']), [])
    assert.equal(qmdIncrementalRenderRoots(root, []), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a chapter-plus-config edit widens to the whole project', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-scope-config-'))
  try {
    writeFileSync(join(root, '_quarto.yml'), `project:\n  type: tlda\nbook:\n  chapters:\n    - index.qmd\n    - chapters/one.qmd\n`)
    // Config detection is name-based: the files need not exist.
    assert.equal(qmdIncrementalRenderRoots(root, ['chapters/one.qmd', '_quarto.yml']), null)
    assert.equal(qmdIncrementalRenderRoots(root, ['chapters/one.qmd', '_quarto-slides.yml']), null)
    assert.equal(qmdIncrementalRenderRoots(root, ['chapters/one.qmd', '_extensions/tlda/tlda-manifest.lua']), null)
    assert.equal(qmdIncrementalRenderRoots(root, ['_quarto.yml']), null)
    assert.deepEqual(qmdIncrementalRenderRoots(root, ['chapters/one.qmd']), ['chapters/one.qmd'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a chapter-plus-orphan edit keeps the chapter', () => {
  // The dropped-edit regression: chapter + `_quarto.yml` once rendered only
  // index.qmd while the chapter edit sat missing from its page, build green.
  // A set that omits a changed root is never returned now.
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-scope-mixed-'))
  try {
    writeFileSync(join(root, '_quarto.yml'), `project:\n  type: tlda\nbook:\n  chapters:\n    - index.qmd\n    - chapters/one.qmd\n`)
    assert.deepEqual(
      qmdIncrementalRenderRoots(root, ['chapters/one.qmd', 'notes.txt']),
      ['chapters/one.qmd'],
    )
    assert.deepEqual(qmdUnplacedChangedFiles(root, ['chapters/one.qmd', 'notes.txt']), ['notes.txt'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('quarto configuration is the project file, its profiles and its extensions', () => {
  assert.equal(isQuartoConfigFile('_quarto.yml'), true)
  assert.equal(isQuartoConfigFile('_quarto.yaml'), true)
  assert.equal(isQuartoConfigFile('_quarto-slides.yml'), true)
  assert.equal(isQuartoConfigFile('_extensions/tlda/tlda-manifest.lua'), true)
  assert.equal(isQuartoConfigFile('chapters/one.qmd'), false)
  assert.equal(isQuartoConfigFile('homework/handouts/a-handout.zip'), false)
  assert.equal(isQuartoConfigFile('_quarto.yml.bak'), false)
})

function writeLinkIncludeFixture(root) {
  mkdirSync(join(root, 'chapters'), { recursive: true })
  writeFileSync(join(root, '_quarto.yml'), `project:\n  type: tlda\nbook:\n  chapters:\n    - index.qmd\n    - chapters/one.qmd\n`)
  // The link is load-bearing: index links the chapter the way the course
  // schedule page links every chapter. A link is navigation, not a build
  // dependency, so it must not mark index stale.
  writeFileSync(join(root, 'index.qmd'), '# Index\n\nRead [chapter one](chapters/one.qmd).\n')
  writeFileSync(join(root, 'chapters', 'one.qmd'), '# One\n\n{{< include ../shared.qmd >}}\n')
  writeFileSync(join(root, 'shared.qmd'), 'Shared prose.\n')
}

test('a chapter edit does not stale the page that links it', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-stale-link-'))
  try {
    writeLinkIncludeFixture(root)
    assert.deepEqual(qmdDocumentsStaleByDependency(root, ['chapters/one.qmd']), [])
    assert.deepEqual(qmdIncrementalRenderRoots(root, ['chapters/one.qmd']), ['chapters/one.qmd'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a shared-input edit renders the documents that include it', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-stale-include-'))
  try {
    writeLinkIncludeFixture(root)
    assert.deepEqual(qmdDocumentsStaleByDependency(root, ['shared.qmd']), ['chapters/one.qmd'])
    assert.deepEqual(qmdIncrementalRenderRoots(root, ['shared.qmd']), ['chapters/one.qmd'])
    assert.deepEqual(qmdUnplacedChangedFiles(root, ['shared.qmd', 'notes.txt']), ['notes.txt'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('only pages this build rendered may be rewritten', () => {
  // The accretion guard at unit level: source-line marking is not idempotent
  // across passes (measured +184 bytes on an untouched chapter), so the
  // post-render loop must not touch seeded pages. The real-build version of
  // this lives in build-qmd-component-render.test.mjs.
  const page = (file) => ({ file: `${file}.html`, source: { file } })
  const rendered = [page('index.qmd'), page('chapters/one.qmd')]
  const seeded = new Set(['index.qmd', 'chapters/one.qmd'])
  assert.deepEqual(
    [...qmdFreshPageSources(rendered, [page('chapters/one.qmd')], seeded, ['chapters/one.qmd'])],
    ['chapters/one.qmd'],
  )
  assert.deepEqual(
    [...qmdFreshPageSources(rendered, [], seeded, [])].sort(),
    [],
  )
  assert.deepEqual(
    [...qmdFreshPageSources(rendered, [], seeded, null)].sort(),
    ['chapters/one.qmd', 'index.qmd'],
  )
  assert.deepEqual(
    [...qmdFreshPageSources([...rendered, page('chapters/two.qmd')], [], seeded, [])].sort(),
    ['chapters/two.qmd'],
  )
})

test('a component render invalidates only that component freeze', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-freeze-test-'))
  try {
    const changed = join(root, '_freeze', 'lectures', 'chapter-calibration-binary')
    const retained = join(root, '_freeze', 'lectures', 'other')
    mkdirSync(changed, { recursive: true })
    mkdirSync(retained, { recursive: true })
    writeFileSync(join(changed, 'execute-results.json'), 'stale')
    writeFileSync(join(retained, 'execute-results.json'), 'current')

    clearQmdFreeze(root, 'lectures/chapter-calibration-binary.qmd')

    assert.equal(existsSync(changed), false)
    assert.equal(existsSync(join(retained, 'execute-results.json')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a prose component written beside its source replaces the book page', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-publish-test-'))
  try {
    mkdirSync(join(root, 'lectures', 'chapter_files'), { recursive: true })
    mkdirSync(join(root, '_book', 'lectures', 'chapter_files'), { recursive: true })
    writeFileSync(join(root, '_book', 'tlda-manifest.json'), '{"version":1,"kind":"tlda","pages":[]}\n')
    writeFileSync(join(root, 'lectures', 'chapter.html'), '<html><body>new chapter</body></html>')
    writeFileSync(join(root, 'lectures', 'chapter_files', 'figure.svg'), 'new figure')
    writeFileSync(join(root, '_book', 'lectures', 'chapter.html'), 'old chapter')

    assert.equal(publishIncrementalQmdOutput(root, 'lectures/chapter.qmd'), true)
    assert.match(readFileSync(join(root, '_book', 'lectures', 'chapter.html'), 'utf8'), /new chapter/)
    assert.equal(readFileSync(join(root, '_book', 'lectures', 'chapter_files', 'figure.svg'), 'utf8'), 'new figure')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a reveal component cannot replace the last good book chapter', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-publish-deck-test-'))
  try {
    mkdirSync(join(root, 'lectures'), { recursive: true })
    mkdirSync(join(root, '_book', 'lectures'), { recursive: true })
    writeFileSync(join(root, '_book', 'tlda-manifest.json'), '{"version":1,"kind":"tlda","pages":[]}\n')
    writeFileSync(join(root, 'lectures', 'chapter.html'), '<div class="reveal"><div class="slides"></div></div>')
    writeFileSync(join(root, '_book', 'lectures', 'chapter.html'), 'last good chapter')

    assert.throws(
      () => publishIncrementalQmdOutput(root, 'lectures/chapter.qmd'),
      /produced a reveal deck instead of a book chapter/,
    )
    assert.equal(readFileSync(join(root, '_book', 'lectures', 'chapter.html'), 'utf8'), 'last good chapter')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an incremental scope without a seed renders everything', () => {
  assert.equal(changedFilesWithSeedFallback(['chapters/one.qmd'], false), null)
  assert.deepEqual(changedFilesWithSeedFallback(['chapters/one.qmd'], true), ['chapters/one.qmd'])
  assert.equal(changedFilesWithSeedFallback(null, false), null)
  assert.deepEqual(changedFilesWithSeedFallback([], false), [])
  assert.deepEqual(changedFilesWithSeedFallback(['chapters/one.qmd'], null), ['chapters/one.qmd'])
})
