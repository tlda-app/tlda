import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('default TeX gates require the TeX operation router', async () => {
  const config = JSON.parse(await readFile(new URL('../server/qualifications-default.json', import.meta.url), 'utf8'))
  const writingRules = config.rules.filter(rule => ['*.tex', '*.bib', '*.md'].includes(rule.edit))
  assert.deepEqual(writingRules.map(rule => rule.requires), [
    ['editing-tex'],
    ['editing-tex'],
    ['editing-tex'],
  ])
})

test('default gates do not infer a workflow from code file extensions', async () => {
  const config = JSON.parse(await readFile(new URL('../server/qualifications-default.json', import.meta.url), 'utf8'))
  const nonTexEditRules = config.rules.filter(rule => rule.edit && !['*.tex', '*.bib', '*.md'].includes(rule.edit))
  assert.deepEqual(nonTexEditRules, [])
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
