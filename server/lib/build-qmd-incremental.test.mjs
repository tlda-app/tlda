import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { clearQmdFreeze, qmdIncrementalRenderRoots } from './build-qmd.mjs'

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
