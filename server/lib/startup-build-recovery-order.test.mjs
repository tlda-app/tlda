import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const serverSource = readFileSync(
  fileURLToPath(new URL('../unified-server.mjs', import.meta.url)),
  'utf8',
)

test('proposal build recovery starts only after the serving port opens', () => {
  const listenAt = serverSource.indexOf('server.listen(PORT, HOST, () => {')
  const recoveryAt = serverSource.indexOf('recoverProposalBuilds().catch')

  assert.notEqual(listenAt, -1)
  assert.notEqual(recoveryAt, -1)
  assert.ok(recoveryAt > listenAt)
})
