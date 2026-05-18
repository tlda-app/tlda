#!/usr/bin/env node
// CLI wrapper for server/lib/lint-suppress.mjs.
//
// Usage:
//   tlda-lint-suppress              # lint git staged diff (use as pre-commit hook)
//   tlda-lint-suppress --range R    # lint a git range (e.g. HEAD~1..HEAD)
//   tlda-lint-suppress --diff -     # lint diff piped on stdin
//
// Exit code is always 0 (advisory) — findings print to stderr; we never
// block. The whole point is to surface the pattern, not annoy the dev when
// they have a legitimate reason to suppress.

import { execSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const libPath = join(repoRoot, 'server', 'lib', 'lint-suppress.mjs')

const { lintDiff, formatFindings } = await import(libPath)

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

if (findings.length > 0) {
  process.stderr.write(formatFindings(findings))
  process.stderr.write('\n')
}

// Always exit 0 — advisory only.
process.exit(0)
