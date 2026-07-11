import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createProject,
  deleteSourceFile,
  initProjectStore,
  readSourceFile,
  writeSourceFile,
} from '../server/lib/project-store.mjs'

test('source file helpers reject sibling-prefix path traversal', () => {
  const projectsDir = mkdtempSync(join(tmpdir(), 'project-store-containment-'))
  initProjectStore(projectsDir)
  createProject({ name: 'paper', mainFile: 'main.tex' })

  assert.throws(
    () => writeSourceFile('paper', '../source2/escaped.md', 'escaped'),
    /Invalid file path/,
  )
  assert.equal(existsSync(join(projectsDir, 'paper', 'source2', 'escaped.md')), false)
  assert.throws(
    () => readSourceFile('paper', '../source2/escaped.md'),
    /Invalid file path/,
  )
  assert.throws(
    () => deleteSourceFile('paper', '../source2/escaped.md'),
    /Invalid file path/,
  )
})
