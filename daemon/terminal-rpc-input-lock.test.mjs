import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { createTerminalRpc } from './terminal-rpc.mjs'
import { acquirePaneInputLock } from '../shared/pane-input-lock.mjs'

process.env.TLDA_PANE_INPUT_DIR = mkdtempSync(path.join(os.tmpdir(), 'daemon-input-lock-test-'))

const silent = { info() {}, warn() {}, error() {}, debug() {} }

function makeRpc(tmuxCalls) {
  return createTerminalRpc({
    log: silent,
    sendMsg() {},
    detectPrompt: () => ({ type: 'none' }),
    onArmBySession() {},
    onSessionInventoryChanged() {},
    resolveAgentRoute: () => ({ tmux_session: 'lock-test-session' }),
    terminalInputAllowed: true,
    execFileImpl: async (cmd, args) => {
      tmuxCalls.push([cmd, ...(args || [])])
      return { stdout: '' }
    },
  })
}

test('daemon send-text waits for the pane input lock, then writes in order', async () => {
  const tmuxCalls = []
  const rpc = makeRpc(tmuxCalls)
  const held = await acquirePaneInputLock('lock-test-session', { op: 'test-hold' })
  let settled = false
  const pending = rpc.handlers['send-text']({ text: 'hello', enter_delay_ms: 0 }).then(
    value => { settled = true; return value },
    err => { settled = true; throw err },
  )
  await new Promise(r => setTimeout(r, 300))
  assert.equal(settled, false)
  assert.deepEqual(tmuxCalls, [])
  held.release()
  const result = await pending
  assert.equal(result.ok, true)
  // Precheck capture first, then the text and its Enter, in order.
  assert.ok(tmuxCalls[0].includes('capture-pane'), `first call captures, got ${JSON.stringify(tmuxCalls[0])}`)
  const keys = tmuxCalls.filter(c => c[1] === 'send-keys').map(c => c[c.length - 1])
  assert.deepEqual(keys, ['hello', 'Enter'])
})

test('daemon auto-accept skips on a busy lock instead of stalling', async () => {
  const tmuxCalls = []
  const rpc = makeRpc(tmuxCalls)
  const held = await acquirePaneInputLock('lock-test-session', { op: 'test-hold' })
  try {
    const skipped = await rpc.autoAcceptPrompt('lock-test-session', 'test prompt', '1')
    assert.equal(skipped, false)
    assert.deepEqual(tmuxCalls, [])
  } finally {
    held.release()
  }
  const accepted = await rpc.autoAcceptPrompt('lock-test-session', 'test prompt', '1')
  assert.equal(accepted, true)
  const keys = tmuxCalls.filter(c => c[1] === 'send-keys').map(c => c[c.length - 1])
  assert.deepEqual(keys, ['1', 'Enter'])
})
