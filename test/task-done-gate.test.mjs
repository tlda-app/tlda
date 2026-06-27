// Regression guard for the task-close gate.
//
// Skip, verbatim: "the task close gate only ever was supposed to hinge on my
// approval, not filesystem." The task_done handler used to run `git diff HEAD`
// over the whole working tree and refuse to close on ANY uncommitted edit —
// including files the agent does not own on a shared tree — which deadlocked
// agents. These tests lock two things:
//   1. lintReport never reads the filesystem and is safe with a null gitDiff
//      (the new call site passes null) while still flagging report-text issues.
//   2. The task_done handler source contains no git/filesystem read and no
//      "uncommitted file edits" block — so the gate can't be re-added silently.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { lintReport } from '../mcp-server/fleet-tools.mjs'

const FLEET_TOOLS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'mcp-server', 'fleet-tools.mjs',
)

test('lintReport with a null gitDiff produces no diff-derived violations', () => {
  // The new task_done call site passes gitDiff=null. A clean report text must
  // yield zero violations and must not throw on the null diff.
  const violations = lintReport('Removed the two filesystem gates from task_done.', null, [])
  assert.deepEqual(violations, [])
})

test('lintReport still flags report-text issues (text lint preserved)', () => {
  // The text lint is preserved (surfaced as a non-blocking advisory now).
  const violations = lintReport('We should add tests next.', null, [])
  assert.ok(violations.length > 0, 'expected a plans-plan violation for "we should"')
  assert.ok(violations.every(v => v.id && v.pattern), 'violations are well-formed')
})

test('lintReport overrides suppress matching violations', () => {
  const all = lintReport('We should add tests next.', null, [])
  const overridden = lintReport('We should add tests next.', null, all.map(v => v.id))
  assert.deepEqual(overridden, [])
})

test('task_done handler reads no filesystem state and has no uncommitted-edits gate', () => {
  const src = readFileSync(FLEET_TOOLS, 'utf8')

  // Isolate the task_done handler block: from its marker to the next handler.
  const start = src.indexOf("// ---- task_done ----")
  assert.ok(start >= 0, 'task_done handler marker not found')
  // The handler ends where the next top-level `if (name === ...)` handler begins.
  const after = src.indexOf("if (name ===", start + 50)
  const rawBlock = src.slice(start, after > start ? after : start + 4000)
  // Check actual code, not the comment that documents the removal — strip
  // line comments so the explanatory prose ("the old gate ran git diff …")
  // doesn't trip the guards.
  const code = rawBlock.split('\n').map(l => l.replace(/\s*\/\/.*$/, '')).join('\n')

  assert.equal(/execSync/.test(code), false, 'task_done gate must not shell out to the filesystem')
  assert.equal(/git diff/.test(code), false, 'task_done gate must not run git diff')
  assert.equal(/uncommitted file edits/.test(code), false,
    'task_done must not block on uncommitted file edits')
  assert.equal(/File report\(\) before task_done/.test(code), false,
    'the report-before-done filesystem gate must stay removed')
})
