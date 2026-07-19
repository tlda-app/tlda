import assert from 'node:assert/strict'
import test from 'node:test'

import { detectPrompt } from '../daemon/prompt-plan.mjs'
import { createTerminalRpc, promptAcceptanceInput } from '../daemon/terminal-rpc.mjs'

const UPDATE_DIALOG = `
╭─ Update available! ─╮
│ A newer Codex version is available. │
╰─ Press enter to continue ─╯
`

test('exact Codex update continuation dialog is accepted with Enter only', () => {
  assert.deepEqual(detectPrompt(UPDATE_DIALOG), {
    type: 'auto-accept',
    reason: 'codex update continuation',
    acceptKey: 'Enter',
  })
  assert.deepEqual(promptAcceptanceInput('Enter'), { pty: '\r', tmuxKeys: ['Enter'] })
})

test('similar and unknown prompts are not accepted as update continuations', () => {
  assert.equal(detectPrompt('Update available. Choose whether to install now. Press enter to continue.').type, 'none')
  assert.equal(detectPrompt('Press enter to continue.').type, 'none')
  assert.equal(detectPrompt('An update is ready. Press enter to continue.').type, 'none')
})

test('unrelated surrounding pane text does not suppress the exact update dialog', () => {
  const pane = `Earlier queued task: no edits, select no deployment route, and allow no live mutation.\n${UPDATE_DIALOG}`
  assert.equal(detectPrompt(pane).reason, 'codex update continuation')
})

test('permission and choice prompts retain their existing non-update handling', () => {
  assert.notEqual(detectPrompt('Allow this command? (y/n)').type, 'auto-accept')
  assert.notEqual(detectPrompt('Update available. Pick 1 or 2. Press enter to continue.').type, 'auto-accept')
})

test('queued task text is delivered after Enter-only update acceptance', async () => {
  const calls = []
  const terminal = createTerminalRpc({
    tmuxArgs: [],
    log: { info() {}, warn() {}, error() {} },
    sendMsg() {},
    detectPrompt,
    stripAnsi: s => s,
    promptCooldowns: new Map(),
    surfacedPrompts: new Map(),
    alivenessCache: new Map(),
    thinkingSpinnerRe: /never-match/,
    interruptHintRe: /never-match/,
    thinkingScanLines: 10,
    terminalSizePollMs: 1000,
    decideTerminalWatchExit: () => ({ terminalDead: true }),
    onArmAgent() {},
    onArmBySession() {},
    onEmitAgentStatus() {},
    onPlanModeSeen() {},
    onPlanModeGone() {},
    hasPlanMode: () => false,
    validateTmuxOwner() {},
    async execFileImpl(_command, args) {
      calls.push(args.slice(0, 4))
      return { stdout: args.includes('capture-pane') ? UPDATE_DIALOG : '' }
    },
  })

  await terminal.handlers['send-text']({
    agent_id: 'fleet:chief-like',
    session_id: 'session-chief-like',
    tmux_session: 'fleet-chief-like',
    text: '📬 Task recovery: owned work remains.',
    enter: true,
    enter_delay_ms: 0,
  })

  assert.deepEqual(calls, [
    ['capture-pane', '-t', 'fleet-chief-like', '-p'],
    ['send-keys', '-t', 'fleet-chief-like', 'Enter'],
    ['send-keys', '-t', 'fleet-chief-like', '--'],
    ['send-keys', '-t', 'fleet-chief-like', 'Enter'],
  ])
})
