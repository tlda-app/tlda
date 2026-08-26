/**
 * **A relink declares what the project already declares — including nothing.**
 *
 * `project link` derived roots from the main file whenever none were supplied,
 * and the relink path PATCHes the result. So relinking a project that declares
 * no roots wrote one in on its behalf, during what is supposed to be a repair.
 *
 * **Why this is a unit test and not a CLI one.** The CLI binds to the local
 * fleet daemon BEFORE it writes the project record, so in an environment
 * without a daemon it never reaches the write — the record can neither change
 * nor be observed. A CLI test therefore proves this only on a machine that
 * happens to be running a daemon, which is how an earlier version of it passed
 * here and failed on a colleague's fresh checkout after six
 * `local fleet daemon is unavailable` retries.
 *
 * The decision itself has no daemon in it. Named, exported, and checked
 * directly, it is provable anywhere.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { documentRootsToDeclare } from './document-roots.mjs'

test('relinking a project that declares no roots declares no roots', () => {
  // THE BUG. Before this, an existing rootless project came back with a root
  // derived from its main file, which the relink then wrote to the record.
  assert.deepEqual(
    documentRootsToDeclare({ supplied: [], existing: [], mainFile: 'main.tex', projectExists: true }),
    [],
    'nothing is declared on the project\'s behalf',
  )
})

test('relinking keeps the declaration it has', () => {
  const existing = [{ path: 'paper.tex', format: 'svg' }, { path: 'notes.md', format: 'markdown' }]
  assert.deepEqual(
    documentRootsToDeclare({ supplied: [], existing, mainFile: 'paper.tex', projectExists: true }),
    existing,
    'an existing declaration passes through untouched',
  )
})

test('CREATING a project still derives roots from the main file', () => {
  // The other half. Making roots optional for a relink must not make them
  // optional for creation, or `project link` starts inventing a declaration
  // from whatever directory it was run in.
  const created = documentRootsToDeclare({ supplied: [], existing: [], mainFile: 'main.tex', projectExists: false })
  assert.equal(created.length, 1, `a new project gets its main file as a root (got ${JSON.stringify(created)})`)
  assert.equal(typeof created[0] === 'string' ? created[0] : created[0].path, 'main.tex')
})

test('supplied roots always win', () => {
  const supplied = [{ path: 'chosen.tex', format: 'svg' }]
  assert.deepEqual(
    documentRootsToDeclare({ supplied, existing: [{ path: 'old.tex' }], mainFile: 'main.tex', projectExists: true }),
    supplied,
    'naming roots explicitly overrides both the existing declaration and the main file',
  )
})
