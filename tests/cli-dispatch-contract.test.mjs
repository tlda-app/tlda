import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const cliSource = readFileSync(new URL('../cli/tlda.mjs', import.meta.url), 'utf8')

function dispatchCase(command) {
  const pattern = new RegExp(`case '${command}':(?<body>.*?)break`, 's')
  const match = cliSource.match(pattern)
  assert.ok(match, `missing dispatch case for ${command}`)
  return match.groups.body
}

test('daemon control does not auto-start the server before recovery work', () => {
  assert.doesNotMatch(dispatchCase('daemon'), /\bensureServer\s*\(/)
})

test('system status reports state without mutating server state first', () => {
  assert.doesNotMatch(dispatchCase('system'), /\bensureServer\s*\(/)
})
