import assert from 'node:assert/strict'
import { accessSync, constants, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const shim = fileURLToPath(new URL('./fleet-spawn.py', import.meta.url))

test('fleet-spawn.py is an executable tlda agent wake shim', () => {
  accessSync(shim, constants.X_OK)
  const source = readFileSync(shim, 'utf8')
  assert.match(source, /os\.execvp\("tlda", \["tlda", "agent", "wake"/)
})

test('fleet-spawn.py has a local help path that does not spawn', () => {
  const result = spawnSync(shim, ['--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /Delegates to: tlda agent wake/)
})
