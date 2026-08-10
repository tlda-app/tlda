#!/usr/bin/env node
// A test whose imports no longer resolve reports nothing at all.
//
// bin/agent-route-spawn-contract-test.mjs imported server/lib/agent-route-events.mjs,
// which was deleted on 2026-07-28 in 5df067015. It did not fail — it could not
// start, and a test that cannot start is indistinguishable from a test that
// passes. It was the contract test for the exact surface that then broke, and it
// was silent for eleven days while an agent Skip needed became unreanimatable.
// That stale import was repaired in 2b30da39a; the incident remains the reason
// this guard exists.
//
// Static on purpose. Importing a test file runs it, and these spawn agents and
// hit the server; a guard must not have side effects. Resolving the relative
// imports is enough to catch the whole class — a test rotted into non-existence
// by a deletion elsewhere.
//
// This does NOT check that tests pass, or that anything runs them. As of writing,
// 194 test files are discovered by the full suite runner; the release gate still
// runs five until the red suite is triaged.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = ['bin', 'tests', 'test', 'scripts', 'server', 'shared', 'daemon', 'packages', 'mcp-server']
const IS_TEST = /(?:^|[-.])test\.(?:mjs|js|ts)$/

const files = []
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'scratch' || entry.name === '.git') {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      visit(full)
    } else if (entry.isFile() && IS_TEST.test(entry.name)) {
      files.push(full)
    }
  }
}

for (const dir of DIRS) {
  const full = path.join(ROOT, dir)
  if (!fs.existsSync(full)) continue
  visit(full)
}

const broken = []
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  for (const match of src.matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
    const spec = match[1]
    const target = path.resolve(path.dirname(file), spec)
    const candidates = [target, target + '.mjs', target + '.js', target + '.ts', path.join(target, 'index.mjs')]
    if (!candidates.some(c => fs.existsSync(c))) {
      broken.push(`${path.relative(ROOT, file)} imports ${spec}, which does not exist`)
    }
  }
}

if (broken.length) {
  console.error('Test files that cannot load:')
  for (const line of broken) console.error('  ' + line)
  console.error(`\n${broken.length} test file import(s) unresolvable. A test that cannot start reports nothing.`)
  process.exit(1)
}
console.log(`test-import-guard: ${files.length} test files, all relative imports resolve`)
