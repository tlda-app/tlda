import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCmd } from './codex.mjs'

test('fresh codex launches cannot stop at the interactive update prompt', () => {
  const cmd = buildCmd({
    fleetId: 'fleet:test',
    localAgentId: 'local:test',
    tmuxSession: 'fleet-test',
    cwd: process.cwd(),
  })

  assert.match(cmd, /-c 'check_for_update_on_startup=false'/)
})
