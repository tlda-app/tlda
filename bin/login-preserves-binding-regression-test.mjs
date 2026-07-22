#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'server', 'unified-server.mjs'), 'utf8')

function sliceBetween(startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle)
  assert.notEqual(start, -1, `missing ${startNeedle}`)
  const end = source.indexOf(endNeedle, start)
  assert.notEqual(end, -1, `missing ${endNeedle}`)
  return source.slice(start, end)
}

function assertPreservesBinding(block, label, existingSyntax = 'existing') {
  for (const field of ['session_id', 'session_ids', 'cwd', 'machine_id', 'env_name', 'daemon_key', 'resume_id']) {
    assert.doesNotMatch(block, new RegExp(`${field}:\\s*null\\b`), `${label} must not wipe ${field}`)
    assert.match(block, new RegExp(`${field}:\\s*${existingSyntax}(?:\\?\\.|\\.)${field}`), `${label} must preserve existing ${field}`)
  }
}

const registerBlock = sliceBetween('const agent = {', '// Persist spawnPolicy ATOMICALLY')
const loginBlock = sliceBetween("if (type === 'login')", 'if (agent.metadata?.spawnPolicy)')

assertPreservesBinding(registerBlock, 'register', 'existing')
assertPreservesBinding(loginBlock, 'login', 'existing')

console.log('login preserves binding regression test passed')
