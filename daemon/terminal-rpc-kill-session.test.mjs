import assert from 'node:assert/strict'
import test from 'node:test'

import { createTerminalRpc } from './terminal-rpc.mjs'

// kill-session answers `ok` in three different situations and only two of them
// mean the agent went down. A caller that hibernates on the strength of `ok`
// alone marks an agent hibernating that is still running, so it re-announces as
// awake and gets re-hibernated every idle period forever. `terminal_unresolved`
// is what separates "I did nothing and know nothing about this agent" from the
// two real outcomes; these tests pin that field to those three branches.

function makeRpc({ ledgerRow, execFileImpl }) {
  const calls = []
  const rpc = createTerminalRpc({
    tmuxArgs: [],
    log: { info() {}, warn() {}, error() {} },
    sendMsg() {},
    detectPrompt: () => ({ type: 'none' }),
    stripAnsi: value => String(value || ''),
    promptCooldowns: new Map(),
    surfacedPrompts: new Map(),
    alivenessCache: new Map(),
    thinkingSpinnerRe: /never-matches/,
    interruptHintRe: /never-matches/,
    thinkingScanLines: 20,
    terminalSizePollMs: 5000,
    decideTerminalWatchExit: () => ({ terminalDead: false }),
    onArmBySession() {},
    onSessionInventoryChanged() {},
    onPlanModeSeen() {},
    onPlanModeGone() {},
    hasPlanMode: () => false,
    resolveAgentRoute: () => ({ agent_id: 'fleet:test', session_id: 'session-1', tmux_session: 'fleet-test' }),
    resolveTerminalAgent: () => ledgerRow,
    validateTmuxOwner: () => true,
    execFileImpl: async (cmd, ...rest) => {
      calls.push([cmd, ...rest[0]])
      return execFileImpl ? execFileImpl(cmd, rest[0]) : { stdout: '' }
    },
  })
  return { rpc, calls }
}

test('no ledger row for this agent: kill-session reports terminal_unresolved and touches no tmux', async () => {
  const { rpc, calls } = makeRpc({ ledgerRow: null })

  const result = await rpc.handlers['kill-session']({ agent_id: 'fleet:test' })

  assert.equal(result.ok, true)
  assert.equal(result.terminal_unresolved, true, 'an unplaceable agent must say so, not just already_unavailable')
  assert.equal(
    calls.filter(call => call[1] === 'kill-session').length,
    0,
    'nothing was killed, so no kill-session may have been issued',
  )
})

test('ledger row with no tmux session recorded is also terminal_unresolved', async () => {
  const { rpc } = makeRpc({ ledgerRow: { id: 'fleet:test', sessionId: null, tmuxSession: null } })

  const result = await rpc.handlers['kill-session']({ agent_id: 'fleet:test' })

  assert.equal(result.terminal_unresolved, true)
})

test('a session that really is killed is not terminal_unresolved', async () => {
  const { rpc, calls } = makeRpc({
    ledgerRow: { id: 'fleet:test', sessionId: 'session-1', tmuxSession: 'fleet-test' },
  })

  const result = await rpc.handlers['kill-session']({ agent_id: 'fleet:test' })

  assert.equal(result.ok, true)
  assert.equal(result.terminal_unresolved, undefined, 'a real kill must not look like an unplaceable agent')
  assert.equal(result.already_unavailable, undefined)
  assert.ok(
    calls.some(call => call[1] === 'kill-session'),
    'the tmux session should actually have been killed',
  )
})

test('a tmux session that was already gone is already_unavailable but NOT terminal_unresolved', async () => {
  const { rpc } = makeRpc({
    ledgerRow: { id: 'fleet:test', sessionId: 'session-1', tmuxSession: 'fleet-test' },
    execFileImpl: (_cmd, args) => {
      if (args.includes('kill-session')) {
        const error = new Error("can't find session: fleet-test")
        error.stderr = "can't find session: fleet-test"
        throw error
      }
      return { stdout: '' }
    },
  })

  const result = await rpc.handlers['kill-session']({ agent_id: 'fleet:test' })

  assert.equal(result.ok, true)
  assert.equal(result.already_unavailable, true)
  assert.equal(
    result.terminal_unresolved,
    undefined,
    'the agent really is down here, so hibernating on this reply is correct',
  )
})
