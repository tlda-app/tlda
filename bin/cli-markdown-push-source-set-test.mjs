#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectProjectSourceHashes } from '../cli/lib/source-files.mjs'
import { diffSourceHashes } from '../shared/source-manifest.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-markdown-push-'))

try {
  const cliSource = fs.readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
  assert.match(
    cliSource,
    /const localHashes = collectProjectSourceHashes\(dir, sourceContext\)/,
    'incremental project push must use the format-aware source-set adapter',
  )

  fs.mkdirSync(path.join(root, 'docs', 'images'), { recursive: true })
  fs.writeFileSync(path.join(root, 'README.md'), '# README\n\n[Guide](docs/guide.md)\n')
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# Guide\n\n![Current](images/current.png)\n')
  fs.writeFileSync(path.join(root, 'docs', 'images', 'current.png'), 'current')
  fs.writeFileSync(path.join(root, 'docs', 'images', 'removed.png'), 'still-authored')
  fs.writeFileSync(path.join(root, 'unrelated.md'), '# Not part of this project\n')

  const hashes = collectProjectSourceHashes(root, {
    format: 'markdown',
    mainFile: 'README.md',
  })

  assert.deepEqual(Object.keys(hashes).sort(), [
    'README.md',
    'docs/guide.md',
    'docs/images/current.png',
  ])

  const { deletedFiles } = diffSourceHashes(hashes, {
    ...hashes,
    'docs/images/removed.png': 'old-hash',
  })
  assert.deepEqual(deletedFiles, ['docs/images/removed.png'])
  assert.equal(fs.existsSync(path.join(root, 'docs', 'images', 'removed.png')), true)

  console.log('cli markdown push source-set tests passed')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
