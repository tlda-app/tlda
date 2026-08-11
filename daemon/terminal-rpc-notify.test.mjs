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

test('notify-agent uses direct tmux injection even when a terminal watch pty is active', async () => {
  const calls = []
  const ptyWrites = []
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
    ptyModuleImpl: {
      spawn() {
        return {
          write(value) { ptyWrites.push(value) },
          resize() {},
          kill() {},
          onData() {},
          onExit() {},
        }
      },
    },
    execFileImpl: async (cmd, args) => {
      calls.push([cmd, ...args])
      if (args.includes('capture-pane')) return { stdout: 'Claude ready\n❯ ' }
      if (args.includes('display-message')) return { stdout: '120 40' }
      return { stdout: '' }
    },
  })

  assert.equal((await rpc.handlers['start-terminal-watch']({ agent_id: 'fleet:test' })).ok, true)

  const result = await rpc.handlers['notify-agent']({
    agent_id: 'fleet:test',
    text: 'LIVE-CLAUDE-WATCH',
    enter_delay_ms: 0,
    ready_timeout_ms: 1000,
    clear_before_text: true,
  })

  assert.equal(result.ok, true)
  assert.equal(result.via, 'tmux')
  assert.deepEqual(ptyWrites, [])
  assert.deepEqual(calls.slice(-3).map(call => call.slice(1)), [
    ['send-keys', '-t', '=fleet-test:', 'C-u'],
    ['send-keys', '-t', '=fleet-test:', '-l', '--', 'LIVE-CLAUDE-WATCH'],
    ['send-keys', '-t', '=fleet-test:', 'Enter'],
  ])
  assert.equal(rpc.handlers['stop-terminal-watch']({ agent_id: 'fleet:test' }).ok, true)
})

test('claude status after an old prompt blocks notification until a later prompt is ready', async () => {
  const calls = []
  const captures = [
    [
      '❯ 💻 Call login() with the tlda MCP server. Then call inbox() to check for a pending task.',
      '✻ Baked for 4s',
    ].join('\n'),
    [
      '❯ 💻 Call login() with the tlda MCP server. Then call inbox() to check for a pending task.',
      '✻ Baked for 4s',
      'login complete',
      '❯ ',
    ].join('\n'),
    'login complete\n❯ ',
  ]
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
      if (args.includes('capture-pane')) return { stdout: captures.shift() || 'login complete\n❯ ' }
      return { stdout: '' }
    },
  })

  const result = await rpc.handlers['notify-agent']({
    agent_id: 'fleet:test',
    text: 'LIVE-CLAUDE-AFTER-STATUS',
    enter_delay_ms: 0,
    ready_timeout_ms: 1200,
    clear_before_text: true,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(calls.slice(-3).map(call => call.slice(1)), [
    ['send-keys', '-t', '=fleet-test:', 'C-u'],
    ['send-keys', '-t', '=fleet-test:', '-l', '--', 'LIVE-CLAUDE-AFTER-STATUS'],
    ['send-keys', '-t', '=fleet-test:', 'Enter'],
  ])
})

test('ready-gated notify-agent does not write after prompt readiness timeout', async () => {
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
      if (args.includes('capture-pane')) {
        return { stdout: '❯ 💻 Call login() with the tlda MCP server. Then call inbox() to check for a pending task.\n✻ Baked for 4s' }
      }
      return { stdout: '' }
    },
  })

  const result = await rpc.handlers['notify-agent']({
    agent_id: 'fleet:test',
    text: 'LIVE-CLAUDE-TIMEOUT',
    enter_delay_ms: 0,
    ready_timeout_ms: 10,
    clear_before_text: true,
  })

  assert.deepEqual(result, { ok: false, reason: 'terminal-not-ready', via: 'none' })
  assert.equal(calls.some(call => call.includes('send-keys')), false)
})
