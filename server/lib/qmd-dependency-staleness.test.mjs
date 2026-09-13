import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { clearQmdFreeze, qmdDocumentsStaleByDependency } from './build-qmd.mjs'

// A book whose chapters reach a shared file by the two routes the course uses:
// `{{< include >}}`, which the markdown closure sees, and `source(...)` from a
// code chunk, which it does not.
function book() {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-dep-'))
  mkdirSync(join(root, 'chapters'), { recursive: true })
  mkdirSync(join(root, 'shared-code'), { recursive: true })
  writeFileSync(join(root, '_quarto.yml'), [
    'project:', '  type: tlda', 'book:', '  chapters:',
    '    - index.qmd',
    '    - chapters/includes-shared.qmd',
    '    - chapters/sources-a-script.qmd',
    '    - chapters/depends-on-nothing.qmd',
    '    - chapters/includes-a-sourcer.qmd',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'index.qmd'), '# i\n')
  writeFileSync(join(root, 'chapters/shared.qmd'), '# shared\n')
  writeFileSync(join(root, 'shared-code/estimators.R'), 'VALUE <- 1\n')
  writeFileSync(join(root, 'chapters/includes-shared.qmd'), '# a\n\n{{< include shared.qmd >}}\n')
  writeFileSync(join(root, 'chapters/sources-a-script.qmd'), [
    '# b', '', '```{r}', "source('../shared-code/estimators.R')", '```', '',
  ].join('\n'))
  writeFileSync(join(root, 'chapters/depends-on-nothing.qmd'), '# c\n')
  // The third route, and the one the course actually uses most: the chapter
  // includes a file, and the `source(...)` lives inside THAT file. Modelled on
  // chapters/ca-income.qmd, which ten declared chapters include and which
  // sources ../shared-code/income.R.
  writeFileSync(join(root, 'shared-code/income.R'), 'INCOME <- 1\n')
  writeFileSync(join(root, 'chapters/uses-income.qmd'), [
    '## income', '', '```{r}', "source('../shared-code/income.R')", '```', '',
  ].join('\n'))
  writeFileSync(join(root, 'chapters/includes-a-sourcer.qmd'), '# d\n\n{{< include uses-income.qmd >}}\n')
  return root
}

// The defect in one assertion. Quarto's hash is the document's own bytes, so a
// changed include invalidates nothing and the chapter thaws its old results --
// on a whole-book render exactly as much as on a one-chapter one.
test('a document that includes a changed file is stale', () => {
  const root = book()
  try {
    assert.deepEqual(
      qmdDocumentsStaleByDependency(root, ['chapters/shared.qmd']),
      ['chapters/includes-shared.qmd'],
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// The markdown closure walks includes and assets; `source(...)` is neither. On
// the real course 2 of 37 dependent chapters reach shared code this way, so a
// fix that covers only includes leaves exactly those silently stale.
test('a document that sources a changed script is stale', () => {
  const root = book()
  try {
    assert.deepEqual(
      qmdDocumentsStaleByDependency(root, ['shared-code/estimators.R']),
      ['chapters/sources-a-script.qmd'],
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// The other direction, and the one that decides whether this is usable: marking
// too much stale re-executes chapters for nothing, which on this book is the
// two hours it exists to avoid.
test('a document that depends on nothing that changed is left alone', () => {
  const root = book()
  try {
    const stale = qmdDocumentsStaleByDependency(root, ['chapters/shared.qmd'])
    assert.equal(stale.includes('chapters/depends-on-nothing.qmd'), false)
    assert.equal(stale.includes('chapters/sources-a-script.qmd'), false)
    assert.equal(stale.includes('index.qmd'), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// Quarto's own hash catches the document whose bytes changed, and that is the
// only case it catches. Listing it here would drop a record Quarto was going to
// invalidate anyway and make this look like it does more than it does.
test('the changed document itself is not listed; Quarto already catches that one', () => {
  const root = book()
  try {
    assert.deepEqual(qmdDocumentsStaleByDependency(root, ['chapters/includes-shared.qmd']), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('no changed files means nothing is stale', () => {
  const root = book()
  try {
    assert.deepEqual(qmdDocumentsStaleByDependency(root, []), [])
    assert.deepEqual(qmdDocumentsStaleByDependency(root), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// The staleness list is only worth computing because clearing the record is what
// forces the re-execution. Asserting the pair together keeps the two from
// drifting into a list nobody acts on.
test('clearing a stale document removes the record that would have been thawed', () => {
  const root = book()
  try {
    const record = join(root, '_freeze', 'chapters', 'includes-shared')
    mkdirSync(join(record, 'execute-results'), { recursive: true })
    writeFileSync(join(record, 'execute-results', 'html.json'), '{"hash":"old"}')

    for (const document of qmdDocumentsStaleByDependency(root, ['chapters/shared.qmd'])) {
      clearQmdFreeze(root, document)
    }

    assert.equal(existsSync(record), false, 'the stale record survived, so the old results still thaw')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// The route the first fix missed. `chunkSourcedFiles` was applied to the root
// document only, so a `source(...)` written inside an included file was
// invisible and the script had no dependents at all. Measured on the real
// course before this was written: shared-code/income.R marked 0 chapters stale
// while ten declared chapters reach it through chapters/ca-income.qmd -- and
// income.R is the file repaired to stop it calling a census API at render time,
// so that repair propagated to nothing.
test('a document that includes a file that sources a changed script is stale', () => {
  const root = book()
  try {
    assert.deepEqual(
      qmdDocumentsStaleByDependency(root, ['shared-code/income.R']),
      ['chapters/includes-a-sourcer.qmd'],
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// And the negative for the same route, because a scan that walks the whole
// closure is the one most likely to over-mark.
test('the include-hop scan does not make unrelated chapters stale', () => {
  const root = book()
  try {
    const stale = qmdDocumentsStaleByDependency(root, ['shared-code/income.R'])
    assert.equal(stale.includes('chapters/sources-a-script.qmd'), false)
    assert.equal(stale.includes('chapters/includes-shared.qmd'), false)
    assert.equal(stale.includes('chapters/depends-on-nothing.qmd'), false)
    assert.equal(stale.includes('index.qmd'), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
