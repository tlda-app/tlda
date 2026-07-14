import assert from 'node:assert/strict'
import test from 'node:test'

import { createTerminalRpc } from '../daemon/terminal-rpc.mjs'

function rpc(overrides = {}) {
  return createTerminalRpc({
    tmuxArgs: [],
    log: { info() {}, warn() {}, error() {} },
    sendMsg() {},
    detectPrompt: () => ({ type: 'none' }),
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
    ...overrides,
  })
}

test('daemon terminal RPC rejects id-X tmux-Y before touching tmux', async () => {
  let checks = 0
  const terminal = rpc({
    validateTmuxOwner({ agentId, tmuxSession }) {
      checks += 1
      assert.equal(agentId, 'fleet:66660cc3')
      assert.equal(tmuxSession, 'fleet-liveness')
      throw new Error('tmux endpoint ownership rejected for fleet:66660cc3: tmux fleet-liveness does not match fleet-icantevengetafuckinglist')
    },
  })

  await assert.rejects(
    () => terminal.handlers['capture-pane']({
      agent_id: 'fleet:66660cc3',
      session_id: '019f6034-correct',
      tmux_session: 'fleet-liveness',
      lines: 5,
    }),
    /tmux endpoint ownership rejected.*fleet-liveness.*fleet-icantevengetafuckinglist/
  )
  assert.equal(checks, 1)
})
