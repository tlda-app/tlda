#!/usr/bin/env node
import assert from 'node:assert/strict'
import { GLOBAL_ACTIVITY_RULES, matchGlobalActivityRule } from './todd-global-activity-rules.mjs'

const [rule] = GLOBAL_ACTIVITY_RULES

assert.equal(rule.name, 'app-testing-playwright-install')
assert.equal(rule.cooldownMs, 10 * 60_000)
assert.match(rule.message, /app-testing skill/)
assert.match(rule.message, /tlda-dev pw/)

for (const text of [
  'Bash npx playwright install',
  'Bash npm i playwright',
  'Bash npm install playwright',
  'Bash npm install -D @playwright/test',
  'Bash pnpm add --dev playwright',
  'Bash yarn add playwright',
  'Bash playwright install chromium',
  "_text Chromium isn't installed",
  '_text chromium is not installed',
  '_text install chromium',
]) {
  assert.equal(matchGlobalActivityRule(text)?.name, rule.name, `expected match: ${text}`)
}

for (const text of [
  'Bash tlda-dev pw open http://localhost:5176',
  'Bash npm test',
  '_text using chromium browser through tlda-dev pw',
  'Bash node test/activity-render-diff.test.mjs',
]) {
  assert.equal(matchGlobalActivityRule(text), null, `expected no match: ${text}`)
}
