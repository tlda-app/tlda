import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveAsset, resolveAssetAsync } from './doc-assets.mjs'

test('async document asset resolution preserves direct, alias, and missing results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-doc-assets-'))
  const project = join(root, 'paper')
  const output = join(project, 'output')
  try {
    mkdirSync(output, { recursive: true })
    writeFileSync(join(project, 'project.json'), JSON.stringify({ mainFile: 'article.tex' }))
    writeFileSync(join(output, 'page-1.svg'), '<svg/>')
    writeFileSync(join(output, 'article-lookup.json'), '{}')

    for (const file of ['page-1.svg', 'lookup.json', 'missing.json']) {
      assert.equal(await resolveAssetAsync(root, 'paper', file), resolveAsset(root, 'paper', file))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
