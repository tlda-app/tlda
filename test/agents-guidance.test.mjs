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

test('fleet harness prompts read AGENTS.md without double-reading CLAUDE.md', () => {
  for (const prompt of [
    claude.kickoffPrompt('alpha'),
    codex.kickoffPrompt('beta'),
  ]) {
    assert.match(prompt, /read the project guidance in AGENTS\.md/)
    assert.match(prompt, /Do not read CLAUDE\.md/)
    assert.doesNotMatch(prompt, /read CLAUDE\.md.*read AGENTS\.md/i)
  }

  const recipe = fs.readFileSync('recipes/fleet-deepseek.yaml', 'utf8')
  assert.match(recipe, /read the project guidance in `AGENTS\.md`/)
  assert.match(recipe, /Do not read `CLAUDE\.md`/)
  assert.doesNotMatch(recipe, /read `CLAUDE\.md`[\s\S]{0,120}read `AGENTS\.md`/i)
})
