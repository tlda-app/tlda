import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createProject,
  deleteSourceFile,
  initProjectStore,
  readSourceFile,
  writeSourceFile,
} from '../server/lib/project-store.mjs'
import { resolveContainedPath } from '../server/lib/path-containment.mjs'

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

test('shared containment helper rejects symlink and absolute escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-containment-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'tlda-containment-outside-'))
  mkdirSync(join(root, 'safe'), { recursive: true })
  writeFileSync(join(root, 'safe', 'ok.md'), '# ok\n')
  writeFileSync(join(outside, 'secret.md'), '# secret\n')
  symlinkSync(outside, join(root, 'linked-out'))

  assert.equal(resolveContainedPath(root, 'safe/ok.md'), join(realpathSync(join(root, 'safe')), 'ok.md'))
  assert.throws(() => resolveContainedPath(root, 'linked-out/secret.md'), /Invalid file path/)
  assert.throws(() => resolveContainedPath(root, join(outside, 'secret.md')), /Invalid file path/)
  assert.throws(() => resolveContainedPath(root, root), /Invalid file path/)
  assert.throws(() => resolveContainedPath(root, 'bad\0path.md'), /Invalid file path/)
})
