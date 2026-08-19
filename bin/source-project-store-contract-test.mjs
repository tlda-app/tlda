#!/usr/bin/env node

// Extracted from bin/source-manifest-contract-test.mjs during the old-sync
// strip. These promises do not depend on `processProjectPush` or any accept
// mechanism at all — they are about project-store infrastructure and file
// classification — so they survive the cut unchanged and are moved out
// before the rest of that file's old-path-entangled body dies with it.

import assert from 'assert/strict'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  isSourceFilePath,
} from '../shared/source-manifest.mjs'
import {
  closeProjectStore,
  initProjectStore,
} from '../server/lib/project-store.mjs'

function assertProjectFilesDbPragmas(root) {
  const db = new Database(path.join(root, '..', 'data', 'project-files.sqlite'), { readonly: true })
  try {
    assert.equal(db.pragma('auto_vacuum', { simple: true }), 2, 'project-files DB must use INCREMENTAL auto_vacuum')
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal', 'project-files DB must use WAL')
    assert.equal(db.pragma('synchronous', { simple: true }), 1, 'project-files DB must use NORMAL synchronous mode')
    assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), 1000, 'project-files DB must keep default WAL checkpoint target')
  } finally {
    db.close()
  }
  const projectStore = fs.readFileSync(path.join(process.cwd(), 'server/lib/project-files-store.worker.mjs'), 'utf8')
  assert.match(projectStore, /journal_size_limit = 67108864/, 'project-files DB connection must cap retained journal size')
}

function assertInitCreatesOnlyRequestedMainFile() {
  const source = fs.readFileSync(path.join(process.cwd(), 'cli/tlda.mjs'), 'utf8')
  const initStart = source.indexOf('async function cmdInit')
  const initEnd = source.indexOf('// Fleet-daemon control:', initStart)
  assert.ok(initStart >= 0 && initEnd > initStart, 'cmdInit not found')
  const initSource = source.slice(initStart, initEnd)
  assert.match(initSource, /writeFileSync\(join\(targetDir,\s*mainFile\)/, 'project init must create the requested main file')
  assert.doesNotMatch(initSource, /writeFileSync\(join\(targetDir,\s*['"]README\.md['"]/, 'project init must not seed README.md')
  assert.doesNotMatch(initSource, /git',\s*\['add',\s*mainFile,\s*['"]README\.md['"]/, 'project init must not commit README.md')
  assert.match(initSource, /sourceManifestForFiles\(files,\s*\{\s*format:\s*'svg',\s*mainFile\s*\}\)/, 'LaTeX init must declare the requested main file')
  assert.match(initSource, /sourceManifestForFiles\(files,\s*\{\s*format:\s*'markdown',\s*mainFile\s*\}\)/, 'Markdown init must declare the requested main file')
  assert.match(initSource, /sourceManifestForFiles\(files,\s*\{\s*format:\s*'html',\s*mainFile\s*\}\)/, 'HTML init must declare the requested main file')
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-source-project-store-'))
  await initProjectStore(root)
  try {
    assertProjectFilesDbPragmas(root)
    assert.equal(isSourceFilePath('main.synctex.gz', { mainFile: 'main.tex' }), false)
    assert.equal(isSourceFilePath('main.run.xml', { mainFile: 'main.tex' }), false)
    assert.equal(isSourceFilePath('main.fdb_latexmk', { mainFile: 'main.tex' }), false)
    assert.equal(isSourceFilePath('README.md', { format: 'markdown', mainFile: 'README.md' }), true)
    assertInitCreatesOnlyRequestedMainFile()
    console.log('PASS source project store contract')
  } finally {
    await closeProjectStore()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
