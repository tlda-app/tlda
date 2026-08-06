import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('default writing gates require the current writing skill', async () => {
  const config = JSON.parse(await readFile(new URL('../server/qualifications-default.json', import.meta.url), 'utf8'))
  const writingRules = config.rules.filter(rule => ['*.tex', '*.bib', '*.md'].includes(rule.edit))
  assert.deepEqual(writingRules.map(rule => rule.requires), [
    ['writing-arguments'],
    ['writing-arguments'],
    ['writing-arguments'],
  ])
})

test('skill gates point agents at skill tools, not inaccessible filesystem paths', async () => {
  const [hook, mcp] = await Promise.all([
    readFile(new URL('../bin/education-hook.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../mcp-server/index.mjs', import.meta.url), 'utf8'),
  ])
  assert.match(hook, /Load it with `skill\("/)
  assert.match(mcp, /Load each named skill with your native skill tool/)
  assert.doesNotMatch(mcp, /Read each skill's markdown with your native file reader/)
})
