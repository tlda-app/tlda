import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { retainNativeTldaRender } from './build-qmd.mjs'

test('native tlda publication retains the Quarto output and removes copied source', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-public-'))
  try {
    mkdirSync(join(root, '_book', 'site_libs'), { recursive: true })
    mkdirSync(join(root, 'scratch'), { recursive: true })
    writeFileSync(join(root, '_book', 'index.html'), 'rendered')
    writeFileSync(join(root, '_book', 'site_libs', 'style.css'), 'css')
    writeFileSync(join(root, '_book', 'tlda-manifest.json'), '{}')
    writeFileSync(join(root, 'scratch', 'internal.md'), 'private source')
    writeFileSync(join(root, '.mcp.json'), 'must not publish')

    retainNativeTldaRender(root, join(root, '_book', 'tlda-manifest.json'))

    assert.equal(readFileSync(join(root, '_book', 'index.html'), 'utf8'), 'rendered')
    assert.equal(readFileSync(join(root, '_book', 'site_libs', 'style.css'), 'utf8'), 'css')
    assert.equal(existsSync(join(root, 'scratch')), false)
    assert.equal(existsSync(join(root, '.mcp.json')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('native tlda publication refuses a manifest outside output', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-public-refuse-'))
  try { assert.throws(() => retainNativeTldaRender(root, join(root, '..', 'manifest.json')), /outside/) }
  finally { rmSync(root, { recursive: true, force: true }) }
})
