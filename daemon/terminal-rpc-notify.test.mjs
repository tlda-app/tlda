import assert from 'node:assert/strict'
import test from 'node:test'

import { createTerminalRpc } from './terminal-rpc.mjs'

test('notify-agent waits for a prompt and clears before exact notification text', async () => {
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
    onEmitAgentStatus() {},
    onPlanModeSeen() {},
    onPlanModeGone() {},
    hasPlanMode: () => false,
    resolveAgentRoute: () => ({ agent_id: 'fleet:test', session_id: 'session-1', tmux_session: 'fleet-test' }),
    resolveTerminalAgent: () => ({ id: 'fleet:test', sessionId: 'session-1', tmuxSession: 'fleet-test' }),
    validateTmuxOwner: () => true,
    execFileImpl: async (cmd, args) => {
      calls.push([cmd, ...args])
      if (args.includes('capture-pane')) return { stdout: 'Claude ready\n❯ ' }
      return { stdout: '' }
    },
  })

  const result = await rpc.handlers['notify-agent']({
    agent_id: 'fleet:test',
    text: 'LIVE-CLAUDE-TOKEN',
    enter_delay_ms: 0,
    ready_timeout_ms: 1000,
    clear_before_text: true,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(calls.map(call => call.slice(1)), [
    ['capture-pane', '-t', '=fleet-test:', '-p', '-S', '-50'],
    ['capture-pane', '-t', '=fleet-test:', '-p', '-S', '-50'],
    ['send-keys', '-t', '=fleet-test:', 'C-u'],
    ['send-keys', '-t', '=fleet-test:', '-l', '--', 'LIVE-CLAUDE-TOKEN'],
    ['send-keys', '-t', '=fleet-test:', 'Enter'],
  ])
})

test('old busy text above the prompt tail does not block exact notification text', async () => {
  const calls = []
  const oldBusyPane = [
    'Earlier turn',
    'Working on something from before',
    'Thinking about old context',
    'line 1',
    'line 2',
    'line 3',
    'line 4',
    'line 5',
    'Claude ready',
    '❯ ',
  ].join('\n')
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
    onEmitAgentStatus() {},
    onPlanModeSeen() {},
    onPlanModeGone() {},
    hasPlanMode: () => false,
    resolveAgentRoute: () => ({ agent_id: 'fleet:test', session_id: 'session-1', tmux_session: 'fleet-test' }),
    resolveTerminalAgent: () => ({ id: 'fleet:test', sessionId: 'session-1', tmuxSession: 'fleet-test' }),
    validateTmuxOwner: () => true,
    execFileImpl: async (cmd, args) => {
      calls.push([cmd, ...args])
      if (args.includes('capture-pane')) return { stdout: oldBusyPane }
      return { stdout: '' }
    },
  })

  const result = await rpc.handlers['notify-agent']({
    agent_id: 'fleet:test',
    text: 'LIVE-CLAUDE-OLD-BUSY',
    enter_delay_ms: 0,
    ready_timeout_ms: 1000,
    clear_before_text: true,
  })

  assert.equal(result.ok, true)
  assert.equal(calls.filter(call => call.includes('capture-pane')).length, 2)
  assert.deepEqual(calls.slice(-3).map(call => call.slice(1)), [
    ['send-keys', '-t', '=fleet-test:', 'C-u'],
    ['send-keys', '-t', '=fleet-test:', '-l', '--', 'LIVE-CLAUDE-OLD-BUSY'],
    ['send-keys', '-t', '=fleet-test:', 'Enter'],
  ])
})
