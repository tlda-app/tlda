#!/usr/bin/env node
// CLI wrapper for server/lib/lint-suppress.mjs.
//
// Usage:
//   tlda-lint-suppress              # lint git staged diff (use as pre-commit hook)
//   tlda-lint-suppress --block      # exit 1 when the diff ADDS a blocking pattern
//   tlda-lint-suppress --range R    # lint a git range (e.g. HEAD~1..HEAD)
//   tlda-lint-suppress --diff -     # lint diff piped on stdin
//
// Without --block: advisory — findings print to stderr, exit 0. With --block
// (the pre-commit gate): still prints everything, but exits 1 when the diff adds
// a BLOCKING_PATTERNS hit (error-swallowing catch / bare except: pass). Net-new
// only — the lint is diff-scoped, so legacy hits stay advisory and a reason
// comment exempts a deliberate swallow.

import { execSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const libPath = join(repoRoot, 'server', 'lib', 'lint-suppress.mjs')

const { lintDiff, formatFindings, BLOCKING_PATTERNS } = await import(libPath)

function gitRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function getDiff() {
  const args = process.argv.slice(2)
  if (args.includes('--diff') && args[args.indexOf('--diff') + 1] === '-') {
    // Read from stdin
    return readFileSync(0, 'utf8')
  }
  const rangeIdx = args.indexOf('--range')
  const range = rangeIdx >= 0 ? args[rangeIdx + 1] : null
  if (range) {
    return execSync(`git diff ${range}`, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })
  }
  // Default: staged diff (pre-commit use case)
  return execSync('git diff --cached', { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })
}

const root = gitRoot()
if (!root) {
  // Not a git repo — nothing to do.
  process.exit(0)
}

const diff = getDiff()
if (!diff.trim()) {
  process.exit(0)
}

const findings = lintDiff(diff, (file) => {
  const full = resolve(root, file)
  if (!existsSync(full)) return null
  try { return readFileSync(full, 'utf8') } catch { return null }
})

// --block: fail the gate when the diff ADDS a blocking pattern (net-new only,
// since findings are diff-scoped). Advisory otherwise.
const blocking = process.argv.includes('--block')

if (findings.length > 0) {
  process.stderr.write(formatFindings(findings, { blocking }))
  process.stderr.write('\n')
}

const hasBlocked = findings.some((f) => BLOCKING_PATTERNS.has(f.pattern))
process.exit(blocking && hasBlocked ? 1 : 0)
