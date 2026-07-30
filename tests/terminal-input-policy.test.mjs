import assert from 'node:assert/strict'
import test from 'node:test'
import { createTerminalRpc } from '../daemon/terminal-rpc.mjs'
import { validateDaemonConfigTopLevel } from '../shared/daemon-config-schema.mjs'
import {
  sendKeyAllowedWithoutTextInput,
  terminalInputAllowedFromConfig,
} from '../shared/terminal-input-policy.mjs'

function makeTerminalRpc({ terminalInputAllowed }) {
  const calls = []
  const rpc = createTerminalRpc({
    tmuxArgs: [],
    log: { info() {}, warn() {}, error() {} },
    sendMsg() {},
    detectPrompt: () => ({ type: 'none' }),
    stripAnsi: value => value,
    promptCooldowns: new Map(),
    surfacedPrompts: new Map(),
    alivenessCache: new Map(),
    thinkingSpinnerRe: /NEVER_MATCH/,
    interruptHintRe: /NEVER_MATCH/,
    thinkingScanLines: 5,
    terminalSizePollMs: 1000,
    decideTerminalWatchExit: () => ({ terminalDead: false }),
    onArmAgent() {},
    onArmBySession() {},
    onEmitAgentStatus() {},
    onPlanModeSeen() {},
    onPlanModeGone() {},
    hasPlanMode: () => false,
    resolveAgentRoute: () => ({ tmux_session: 'agent-session', agent_id: 'fleet:test' }),
    validateTmuxOwner: () => true,
    resolveTerminalAgent: () => ({ id: 'fleet:test', tmuxSession: 'agent-session', sessionId: 'session-1' }),
    terminalInputAllowed,
    execFileImpl: async (cmd, args) => {
      calls.push([cmd, args])
      return { stdout: '', stderr: '' }
    },
  })
  return { rpc, calls }
}

test('daemon terminal input defaults to read-only', () => {
  assert.equal(terminalInputAllowedFromConfig({}), false)
  assert.equal(terminalInputAllowedFromConfig({ terminalInputAllowed: false }), false)
  assert.equal(terminalInputAllowedFromConfig({ terminalInputAllowed: true }), true)
})

test('daemon config validates terminalInputAllowed as a boolean', () => {
  assert.doesNotThrow(() => validateDaemonConfigTopLevel({
    environments: { default: 'local', values: { local: { database: 'http://x', store: 'http://x', licenseKey: '' } } },
    terminalInputAllowed: false,
  }))
  assert.throws(() => validateDaemonConfigTopLevel({
    environments: { default: 'local', values: { local: { database: 'http://x', store: 'http://x', licenseKey: '' } } },
    terminalInputAllowed: 'false',
  }), /terminalInputAllowed/)
})

test('read-only policy allows named control send-key but rejects printable keys', async () => {
  assert.equal(sendKeyAllowedWithoutTextInput('C-End'), true)
  assert.equal(sendKeyAllowedWithoutTextInput('BTab'), true)
  assert.equal(sendKeyAllowedWithoutTextInput('a'), false)
  assert.equal(sendKeyAllowedWithoutTextInput('hello'), false)

  const { rpc, calls } = makeTerminalRpc({ terminalInputAllowed: false })
  await assert.rejects(
    () => rpc.handlers['send-key']({ agent_id: 'fleet:test', key: 'a' }),
    /terminal text input is disabled/,
  )
  await rpc.handlers['send-key']({ agent_id: 'fleet:test', key: 'C-End' })
  assert.deepEqual(calls.at(-1), ['tmux', ['send-keys', '-t', '=agent-session:', 'C-End']])
})

test('read-only policy rejects send-text and terminal-input before tmux writes', async () => {
  const { rpc, calls } = makeTerminalRpc({ terminalInputAllowed: false })
  await assert.rejects(
    () => rpc.handlers['send-text']({ agent_id: 'fleet:test', text: 'hello', enter: true }),
    /terminal text input is disabled/,
  )
  assert.throws(
    () => rpc.handlers['terminal-input']({ agent_id: 'fleet:test', data: 'hello' }),
    /terminal text input is disabled/,
  )
  assert.equal(calls.length, 0)
})

test('explicit opt-in preserves terminal text injection', async () => {
  const { rpc, calls } = makeTerminalRpc({ terminalInputAllowed: true })
  await rpc.handlers['send-text']({ agent_id: 'fleet:test', text: 'hello', enter: false })
  assert.deepEqual(calls.at(-1), ['tmux', ['send-keys', '-t', '=agent-session:', '--', 'hello']])
})
