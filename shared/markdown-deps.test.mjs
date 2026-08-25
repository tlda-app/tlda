import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { scanMarkdownDependencyClosure } from './markdown-deps.mjs'

test('Quarto include shortcodes join the recursive document closure', () => {
  const source = mkdtempSync(join(tmpdir(), 'tlda-qmd-deps-'))
  mkdirSync(join(source, 'lectures'))
  writeFileSync(join(source, 'lectures', 'lecture.qmd'), '{{< include ../shared-code.qmd >}}\n')
  writeFileSync(join(source, 'shared-code.qmd'), '{{< include fragments/setup.qmd >}}\n')
  mkdirSync(join(source, 'fragments'))
  writeFileSync(join(source, 'fragments', 'setup.qmd'), '# Setup\n')

  const closure = scanMarkdownDependencyClosure('lectures/lecture.qmd', source)

  assert.deepEqual(closure.files, [
    'fragments/setup.qmd',
    'lectures/lecture.qmd',
    'shared-code.qmd',
  ])
  assert.deepEqual(closure.missing, [])
})
