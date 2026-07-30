import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { runLatexdiffFiles } from '../server/routes/history.mjs'

test('history diff reports missing latexdiff as dependency outage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-history-latexdiff-'))
  try {
    const oldPath = join(dir, 'old.tex')
    const newPath = join(dir, 'new.tex')
    writeFileSync(oldPath, 'old\n')
    writeFileSync(newPath, 'new\n')

    await assert.rejects(
      runLatexdiffFiles(oldPath, newPath, { env: { ...process.env, PATH: '' } }),
      err => {
        assert.equal(err.status, 503)
        assert.equal(err.dependency, 'latexdiff')
        assert.match(err.message, /not installed/)
        return true
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
