import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureSpawnHelperExecutable, nodePtySpawnHelperPath } from './terminal-rpc.mjs'

// The daemon heals node-pty's spawn-helper +x bit at PTY init because deploy
// releases install fresh without an effective postinstall: without the bit
// every PTY spawn fails `posix_spawnp failed`, the terminal watch never
// attaches, and hovers seed once via capture-pane and then never update.

test('derived helper path is the real node-pty prebuild binary', () => {
  const helper = nodePtySpawnHelperPath()
  assert.match(helper, /node-pty\/prebuilds\/[a-z]+-[a-z0-9]+\/spawn-helper$/)
  assert.ok(statSync(helper).isFile(), `expected a real file at ${helper}`)
})

test('ensure sets +x on a non-executable helper and leaves an executable one alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-helper-'))
  const helper = join(dir, 'spawn-helper')
  writeFileSync(helper, '#!/bin/sh\nexit 0\n')
  chmodSync(helper, 0o644)

  const logs = []
  const log = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) }
  const returned = await ensureSpawnHelperExecutable({ log, helperPath: helper })
  assert.equal(returned, helper)
  assert.equal(statSync(helper).mode & 0o111, 0o111)
  assert.ok(logs.some(([level]) => level === 'info'), 'expected an info log for the chmod')

  logs.length = 0
  await ensureSpawnHelperExecutable({ log, helperPath: helper })
  assert.equal(logs.length, 0, 'an executable helper must not log or chmod again')
})

test('ensure never throws, even for a missing helper', async () => {
  const logs = []
  const log = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) }
  const returned = await ensureSpawnHelperExecutable({ log, helperPath: join(tmpdir(), `no-such-helper-${process.pid}`) })
  assert.equal(returned, null)
  assert.ok(logs.some(([level]) => level === 'warn'), 'expected a warn log for the failure')
})
