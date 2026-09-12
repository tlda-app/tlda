import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { materializeAcceptedRevision } from './revision-tree-materializer.mjs'

function fixture(files) {
  const rows = files.map(([path, mode, content]) => ({ path, mode, content: Buffer.from(content) }))
  return {
    revision: { id: 'a'.repeat(40), files: rows.map(({ path, mode }) => ({ path, mode })) },
    lifecycle: { async readRevisionFile(_id, path) { return rows.find(row => row.path === path)?.content || null } },
  }
}

test('materializes relative file and directory links from admitted revision bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-revision-materialize-'))
  try {
    const f = fixture([
      ['bin/tool', '100755', '#!/bin/sh\n'],
      ['data/value.csv', '100644', 'x\n'],
      ['alias.csv', '120000', 'data/value.csv'],
      ['alias-dir', '120000', 'data'],
      ['.mcp.json', '120000', '/outside/private'],
    ])
    await materializeAcceptedRevision({ ...f, destination: root })
    assert.equal(readFileSync(join(root, 'alias.csv'), 'utf8'), 'x\n')
    assert.equal(readFileSync(join(root, 'alias-dir/value.csv'), 'utf8'), 'x\n')
    assert.equal(lstatSync(join(root, 'alias.csv')).isSymbolicLink(), false)
    assert.equal(lstatSync(join(root, 'bin/tool')).mode & 0o777, 0o755)
    assert.throws(() => lstatSync(join(root, '.mcp.json')), /ENOENT/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('refuses escaping, external, unadmitted, cyclic, and special link targets', async () => {
  for (const files of [
    [['link', '120000', '../outside']],
    [['link', '120000', '/outside']],
    [['link', '120000', 'missing']],
    [['a', '120000', 'b'], ['b', '120000', 'a']],
    [['link', '120000', 'target'], ['target', '160000', 'gitlink']],
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'tlda-revision-refuse-'))
    try { await assert.rejects(materializeAcceptedRevision({ ...fixture(files), destination: root })) }
    finally { rmSync(root, { recursive: true, force: true }) }
  }
})
