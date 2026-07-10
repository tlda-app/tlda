#!/usr/bin/env node
/**
 * run-corpus.mjs — pre-merge gate for the chat-scroll/bounce test corpus.
 *
 * Runs every current scroll test under tests/scroll/*.test.mjs and exits
 * non-zero if anything fails.
 *
 * Usage:
 *   node tests/run-corpus.mjs                 # run everything
 *   node tests/run-corpus.mjs --filter image  # only matching paths
 *   node tests/run-corpus.mjs --bail          # stop on first failure
 *
 * Prereqs (the harness checks): vite on TLDA_TEST_PORT (5179), tlda server on 5176,
 * playwright-cli on PATH.
 */

import { spawnSync } from 'child_process'
import { readdirSync } from 'fs'
import { dirname, resolve, join, relative } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const filter = args.includes('--filter') ? args[args.indexOf('--filter') + 1] : null
const bail = args.includes('--bail')

const tests = []
const scrollDir = join(HERE, 'scroll')
try {
  for (const f of readdirSync(scrollDir)) {
    if (f.endsWith('.test.mjs')) tests.push(join(scrollDir, f))
  }
} catch {} // dir may not exist yet

const filtered = filter ? tests.filter(t => t.includes(filter)) : tests
filtered.sort()

if (filtered.length === 0) {
  console.log('No tests matched.')
  process.exit(0)
}

console.log(`\n=== run-corpus: ${filtered.length} test file(s) ===\n`)

const results = []
let failed = 0
for (const t of filtered) {
  const rel = relative(HERE, t)
  console.log(`▶ ${rel}`)
  const start = Date.now()
  const r = spawnSync(process.execPath, [t], {
    stdio: 'inherit',
    env: process.env,
    cwd: dirname(HERE),
  })
  const ms = Date.now() - start
  const ok = r.status === 0
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  (${ms}ms)\n`)
  results.push({ test: rel, pass: ok, ms })
  if (!ok) failed++
  if (!ok && bail) break
}

console.log(`=== SUMMARY ===`)
const passed = results.filter(r => r.pass).length
console.log(`${passed}/${results.length} passed`)
if (failed > 0) {
  console.log('\nFailed test files:')
  results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.test}`))
  process.exit(1)
}
process.exit(0)
