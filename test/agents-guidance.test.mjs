import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'
import * as claude from '../bin/lib/spawn/harness/claude.mjs'
import * as codex from '../bin/lib/spawn/harness/codex.mjs'

test('generated AGENTS.md is current and has expanded includes', () => {
  execFileSync('node', ['bin/gen-agents.mjs', '--check'], { stdio: 'pipe' })
  const agents = fs.readFileSync('AGENTS.md', 'utf8')
  assert.match(agents, /Agents & routing \(tlda\/app lane\)/)
  assert.doesNotMatch(agents, /^@/m)
})

test('Claude Code gets project guidance through the thin CLAUDE importer', () => {
  assert.equal(fs.readFileSync('CLAUDE.md', 'utf8'), '@AGENTS.md\n')
  assert.ok(fs.existsSync('AGENTS.md'))
  assert.equal(claude.kickoffPrompt('alpha'), 'Call register(name="alpha") with the fleet MCP server. Then call my_task() to check for a pending task.')
})

test('non-Claude fleet prompts read AGENTS.md without double-reading CLAUDE.md', () => {
  const codexPrompt = codex.kickoffPrompt('beta')
  assert.match(codexPrompt, /read the project guidance in AGENTS\.md/)
  assert.match(codexPrompt, /Do not read CLAUDE\.md/)
  assert.doesNotMatch(codexPrompt, /read CLAUDE\.md.*read AGENTS\.md/i)

  const recipe = fs.readFileSync('recipes/fleet-deepseek.yaml', 'utf8')
  assert.match(recipe, /read the project guidance in `AGENTS\.md`/)
  assert.match(recipe, /Do not read `CLAUDE\.md`/)
  assert.doesNotMatch(recipe, /read `CLAUDE\.md`[\s\S]{0,120}read `AGENTS\.md`/i)
})
