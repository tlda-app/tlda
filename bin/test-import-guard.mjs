#!/usr/bin/env node
// A test whose imports no longer resolve reports nothing at all.
//
// bin/agent-route-spawn-contract-test.mjs imports server/lib/agent-route-events.mjs,
// which was deleted on 2026-07-28 in 5df067015. It does not fail — it cannot
// start, and a test that cannot start is indistinguishable from a test that
// passes. It was the contract test for the exact surface that then broke, and it
// was silent for eleven days while an agent Skip needed became unreanimatable.
//
// Static on purpose. Importing a test file runs it, and these spawn agents and
// hit the server; a guard must not have side effects. Resolving the relative
// imports is enough to catch the whole class — a test rotted into non-existence
// by a deletion elsewhere.
//
// This does NOT check that tests pass, or that anything runs them. As of writing,
// 127 test files exist in bin/, tests/ and test/, and CI runs five.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = ['bin', 'tests', 'test']
const IS_TEST = /(-test\.mjs|\.test\.mjs|\.test\.ts)$/

const files = []
for (const dir of DIRS) {
  const full = path.join(ROOT, dir)
  if (!fs.existsSync(full)) continue
  for (const name of fs.readdirSync(full)) {
    if (IS_TEST.test(name)) files.push(path.join(full, name))
  }
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
