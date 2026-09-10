import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { qmdIncrementalRenderRoots } from './build-qmd.mjs'

test('a direct book-component edit selects only that component', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-incremental-test-'))
  try {
    mkdirSync(join(root, '_book'), { recursive: true })
    writeFileSync(join(root, '_book', 'tlda-manifest.json'), '{"version":1,"kind":"tlda","pages":[]}\n')
    writeFileSync(join(root, '_quarto.yml'), `book:\n  chapters:\n    - part: index.qmd\n      chapters:\n        - lectures/chapter-calibration-binary.qmd\n        - lectures/other.qmd\n`)
    assert.deepEqual(qmdIncrementalRenderRoots(root, ['lectures/chapter-calibration-binary.qmd']), ['lectures/chapter-calibration-binary.qmd'])
    assert.equal(qmdIncrementalRenderRoots(root, ['shared-code.qmd']), null)
    assert.equal(qmdIncrementalRenderRoots(root, []), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
