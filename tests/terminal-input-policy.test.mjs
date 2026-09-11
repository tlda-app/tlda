import assert from 'node:assert/strict'
import test from 'node:test'
import { createTerminalRpc } from '../daemon/terminal-rpc.mjs'
import { validateDaemonConfigTopLevel } from '../shared/daemon-config-schema.mjs'
import {
  sendKeyAllowedWithoutTextInput,
  terminalInputAllowedFromConfig,
} from '../shared/terminal-input-policy.mjs'

function makeTerminalRpc({
  terminalInputAllowed,
  resolveTerminalAgent = () => ({ id: 'fleet:test', tmuxSession: 'agent-session', sessionId: 'session-1' }),
  onSessionInventoryChanged,
  execFileImpl,
  paneText = '',
}) {
  const calls = []
  const inventoryChanges = []
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
    onSessionInventoryChanged: onSessionInventoryChanged || (reason => { inventoryChanges.push(reason) }),
    onPlanModeSeen() {},
    onPlanModeGone() {},
    hasPlanMode: () => false,
    resolveAgentRoute: () => ({ tmux_session: 'agent-session', agent_id: 'fleet:test' }),
    validateTmuxOwner: () => true,
    resolveTerminalAgent,
    terminalInputAllowed,
    execFileImpl: execFileImpl || (async (cmd, args) => {
      calls.push([cmd, args])
      return { stdout: args.includes('capture-pane') ? paneText : '', stderr: '' }
    }),
  })
  return { rpc, calls, inventoryChanges }
}

function makeTerminalRpcWithPty() {
  const calls = []
  const ptyWrites = []
  const fakePty = {
    write(data) { ptyWrites.push(data) },
    resize() {},
    kill() {},
    onData() {},
    onExit() {},
  }
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
    onSessionInventoryChanged() {},
    onPlanModeSeen() {},
    onPlanModeGone() {},
    hasPlanMode: () => false,
    resolveAgentRoute: () => ({ tmux_session: 'agent-session', agent_id: 'fleet:test' }),
    validateTmuxOwner: () => true,
    resolveTerminalAgent: () => ({ id: 'fleet:test', tmuxSession: 'agent-session', sessionId: 'session-1' }),
    terminalInputAllowed: false,
    ptyModuleImpl: {
      spawn: () => fakePty,
    },
    execFileImpl: async (cmd, args) => {
      calls.push([cmd, args])
      return { stdout: '', stderr: '' }
    },
  })
  return { rpc, calls, ptyWrites }
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

test('the connection notice is submitted only at an empty harness prompt', async t => {
  for (const [name, paneText, delivered] of [
    ['empty harness prompt', 'ready\n❯ ', true],
    ['shell prompt', 'skip@mini tlda % ', false],
    ['unknown state', 'starting up', false],
    ['busy harness', '❯ \nWorking', false],
    ['existing draft', 'ready\n❯ keep this draft', false],
  ]) {
    await t.test(name, async () => {
      const { rpc, calls } = makeTerminalRpc({ terminalInputAllowed: false, paneText })
      const result = await rpc.notifyConnectionDisconnected({ agent_id: 'fleet:test' })
      const setBuffer = calls.find(([, args]) => args[0] === 'set-buffer')
      assert.equal(result.ok, delivered)
      assert.equal(setBuffer?.[1].at(-1), delivered
        ? '💻 The tlda connection seems disconnected. Consider running: tlda-dev restart-mcp fleet:test'
        : undefined)
      assert.equal(calls.some(([, args]) => args.includes('Enter')), delivered)
      assert.equal(calls.some(([, args]) => args.includes('C-u')), false)
    })
  }
})

test('kill-session succeeds when the terminal ledger row is already absent', async () => {
  const { rpc, calls, inventoryChanges } = makeTerminalRpc({
    terminalInputAllowed: false,
    resolveTerminalAgent: () => null,
  })
  const result = await rpc.handlers['kill-session']({ agent_id: 'fleet:test' })
  assert.deepEqual(result, {
    ok: true,
    already_unavailable: true,
    reason: 'terminal already unavailable',
  })
  assert.deepEqual(calls, [])
  assert.deepEqual(inventoryChanges, ['kill-session-unavailable'])
})

test('kill-session rescans authoritative process inventory after tmux removal', async () => {
  const { rpc, calls, inventoryChanges } = makeTerminalRpc({ terminalInputAllowed: false })
  const result = await rpc.handlers['kill-session']({ agent_id: 'fleet:test' })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls, [['tmux', ['kill-session', '-t', '=agent-session']]])
  assert.deepEqual(inventoryChanges, ['kill-session'])
})

test('kill-session waits for authoritative rescan on every terminal outcome', async t => {
  for (const boundary of [
    {
      name: 'removed',
      resolveTerminalAgent: undefined,
      execFileImpl: async () => ({ stdout: '', stderr: '' }),
      reason: 'kill-session',
    },
    {
      name: 'already absent',
      resolveTerminalAgent: undefined,
      execFileImpl: async () => { throw Object.assign(new Error('gone'), { stderr: "can't find session" }) },
      reason: 'kill-session-already-absent',
    },
    {
      name: 'unavailable',
      resolveTerminalAgent: () => null,
      execFileImpl: async () => { throw new Error('tmux must not run') },
      reason: 'kill-session-unavailable',
    },
  ]) {
    await t.test(boundary.name, async () => {
      const rpc = makeTerminalRpc({
        terminalInputAllowed: false,
        resolveTerminalAgent: boundary.resolveTerminalAgent,
        execFileImpl: boundary.execFileImpl,
        onSessionInventoryChanged: async reason => {
          assert.equal(reason, boundary.reason)
          throw new Error('inventory rescan failed')
        },
      }).rpc
      await assert.rejects(
        () => rpc.handlers['kill-session']({ agent_id: 'fleet:test' }),
        /inventory rescan failed/,
      )
    })
  }
})
