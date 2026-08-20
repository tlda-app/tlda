import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const cli = readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')
const daemon = readFileSync(new URL('../bin/fleet-daemon.mjs', import.meta.url), 'utf8')

test('local project link has no HTTP file snapshot fallback', () => {
  assert.doesNotMatch(cli, /\/source-room\/files|\/source-snapshot/)
  assert.match(cli, /project-source-link/)
  assert.match(daemon, /sourceSync\.submit\(project\)/)
})
