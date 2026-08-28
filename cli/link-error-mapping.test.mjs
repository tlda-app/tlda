import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { retryableCliOperationError } from './tlda.mjs'

const NEW_MESSAGES = [
  'local daemon adopt-shadow-history-ref timed out after 30000ms',
  'local daemon adopt-shadow-history-ref failed: no socket at /x/y.sock (ENOENT)',
  'local daemon adopt-shadow-history-ref failed: connection refused at /x/y.sock (ECONNREFUSED)',
]

test('renamed daemon failures remain retryable', () => {
  for (const message of NEW_MESSAGES) {
    assert.equal(retryableCliOperationError(new Error(message)), true,
      `a renamed daemon error must stay retryable: ${message}`)
  }
})

test('daemon failure text names the operation without false repair advice', () => {
  for (const message of NEW_MESSAGES) {
    assert.match(message, /^local daemon \S+ /)
    assert.doesNotMatch(message, /is unavailable|doctor yolo|tlda daemon start/)
  }

  const source = readFileSync(new URL('./tlda.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /local fleet daemon is unavailable/)
  assert.doesNotMatch(source, /local daemon \$\{op\} timed out; use/)
})
