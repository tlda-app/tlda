import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createTerminalRpc } from '../daemon/terminal-rpc.mjs'
import { decideTerminalWatchExit } from '../agent-runtime/daemon-guards.mjs'
import { createPermissionLedger } from '../agent-launch/permission-ledger.mjs'

function createRpc({ ledgerRow = null, killSessionError = null, sendMsg = () => {}, ptyModuleImpl = null, terminalStdout = 'live terminal\n' } = {}) {
  const calls = []
  const rpc = createTerminalRpc({
    tmuxArgs: [],
    log: { info() {}, warn() {}, error() {} },
    sendMsg,
    detectPrompt: () => ({ type: 'none' }),
    stripAnsi: s => s,
    promptCooldowns: new Map(),
    surfacedPrompts: new Map(),
    alivenessCache: new Map(),
    thinkingSpinnerRe: /$a/,
    interruptHintRe: /$a/,
    thinkingScanLines: 10,
    decideTerminalWatchExit: () => ({ terminalDead: true }),
    ptyModuleImpl,
    onArmAgent() {},
    onArmBySession() {},
    onEmitAgentStatus() {},
    onPlanModeSeen() {},
    onPlanModeGone() {},
    hasPlanMode: () => false,
    resolveAgentRoute: ({ agent_id: agentId }) => {
      if (ledgerRow?.id !== agentId || !ledgerRow?.sessionId || !ledgerRow?.tmuxSession) {
        throw new Error(`agent route unavailable for ${agentId}`)
      }
      return {
        agent_id: agentId,
        session_id: ledgerRow.sessionId,
        tmux_session: ledgerRow.tmuxSession,
      }
    },
    validateTmuxOwner: () => {
      throw new Error('server endpoint validation should not run for terminal capabilities')
    },
    resolveTerminalCapability: ({ agentId, terminalCapability }) => {
      if (ledgerRow?.id === agentId && ledgerRow?.terminalCapability === terminalCapability) return ledgerRow
      return null
    },
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args })
      if (args.includes('list-sessions')) return { stdout: `${ledgerRow?.tmuxSession || ''}\n` }
      if (args.includes('kill-session') && killSessionError) throw killSessionError
      return { stdout: typeof terminalStdout === 'function' ? terminalStdout({ cmd, args }) : terminalStdout }
    },
  })
  return { rpc, calls }
}

function fakePtyModule() {
  const ptys = []
  return {
    ptys,
    spawn() {
      const handlers = { data: [], exit: [] }
      const pty = {
        writes: [],
        resizeCalls: [],
        killed: false,
        onData(fn) { handlers.data.push(fn) },
        onExit(fn) { handlers.exit.push(fn) },
        write(data) { this.writes.push(data) },
        resize(cols, rows) { this.resizeCalls.push({ cols, rows }) },
        kill() { this.killed = true },
        emitData(data) { for (const fn of handlers.data) fn(data) },
        emitExit(exitCode = 0) { for (const fn of handlers.exit) fn({ exitCode }) },
      }
      ptys.push(pty)
      return pty
    },
  }
}

{
  assert.equal(decideTerminalWatchExit({ paneLive: true }).terminalDead, false)
  assert.equal(decideTerminalWatchExit({ paneLive: null }).terminalDead, false)
  assert.equal(decideTerminalWatchExit({ paneLive: false }).terminalDead, true)
}

{
  const { rpc, calls } = createRpc({
    ledgerRow: {
      id: 'fleet:cap-test',
      terminalCapability: 'termcap:live',
      sessionId: 'rollout-live',
      tmuxSession: 'daemon-local-tmux-live',
      daemonKey: 'mini:prod',
    },
  })
  const result = await rpc.handlers['capture-pane']({
    agent_id: 'fleet:cap-test',
    lines: 5,
  })

  assert.equal(result.pane, 'live terminal\n')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args.slice(0, 3), ['capture-pane', '-t', 'daemon-local-tmux-live'])
}

{
  const { rpc, calls } = createRpc({
    ledgerRow: {
      id: 'fleet:cap-test',
      terminalCapability: 'termcap:live',
      sessionId: 'rollout-live',
      tmuxSession: 'daemon-local-tmux-live',
      daemonKey: 'mini:prod',
    },
  })
  await rpc.handlers['send-key']({ agent_id: 'fleet:cap-test', key: 'Enter' })
  await rpc.handlers['send-text']({ agent_id: 'fleet:cap-test', text: 'hello', enter: true })
  await rpc.handlers['interrupt']({ agent_id: 'fleet:cap-test' })
  const soft = await rpc.handlers['soft-interrupt']({ agent_id: 'fleet:cap-test', terminal_capability: 'termcap:live' })
  const alive = await rpc.handlers['check-alive']({ agent_id: 'fleet:cap-test', terminal_capability: 'termcap:live' })

  assert.equal(soft.ok, true)
  assert.equal(alive.alive, true)
  assert(calls.some(call => call.args.includes('send-keys') && call.args.includes('Enter')))
  assert(calls.every(call => call.args.includes('daemon-local-tmux-live') || call.args.includes('list-sessions')))
}

for (const [name, payload] of [
  ['soft-interrupt', {}],
  ['check-alive', {}],
  ['kill-session', {}],
  ['start-terminal-watch', {}],
  ['stop-terminal-watch', {}],
  ['terminal-resize', {}],
  ['terminal-input', { data: 'x' }],
]) {
  const { rpc, calls } = createRpc({
    ledgerRow: {
      id: 'fleet:cap-test',
      terminalCapability: 'termcap:live',
      sessionId: 'rollout-live',
      tmuxSession: 'daemon-local-tmux-live',
      daemonKey: 'mini:prod',
    },
  })
  await assert.rejects(
    async () => rpc.handlers[name]({
      agent_id: 'fleet:cap-test',
      session_id: 'rollout-live',
      tmux_session: 'daemon-local-tmux-live',
      ...payload,
    }),
    /terminal capability required/,
    `${name} must not accept raw session/tmux fallback`,
  )
  assert.equal(calls.length, 0, `${name} touched tmux without a capability`)
}

{
  const { rpc, calls } = createRpc({
    ledgerRow: {
      id: 'fleet:cap-test',
      terminalCapability: 'termcap:new-incarnation',
      sessionId: 'rollout-new',
      tmuxSession: 'daemon-local-tmux-new',
      daemonKey: 'mini:prod',
    },
  })

  const result = await rpc.handlers['capture-pane']({
    agent_id: 'fleet:cap-test',
    terminal_capability: 'termcap:old-incarnation',
    lines: 5,
  })
  assert.equal(result.pane, 'live terminal\n')
  assert.equal(calls.length, 1)
}

{
  const { rpc, calls } = createRpc()
  await assert.rejects(
    () => rpc.handlers['capture-pane']({
      agent_id: 'fleet:cap-test',
      terminal_capability: 'termcap:wrong-daemon',
      lines: 5,
    }),
    /agent route unavailable/,
  )
  assert.equal(calls.length, 0)
}

{
  const { rpc, calls } = createRpc({
    ledgerRow: {
      id: 'fleet:cap-test',
      terminalCapability: 'termcap:no-local-terminal',
      sessionId: 'rollout-live',
      tmuxSession: null,
      daemonKey: 'mini:prod',
    },
  })
  await assert.rejects(
    () => rpc.handlers['capture-pane']({
      agent_id: 'fleet:cap-test',
      terminal_capability: 'termcap:no-local-terminal',
      lines: 5,
    }),
    /agent route unavailable/,
  )
  const killed = await rpc.handlers['kill-session']({
    agent_id: 'fleet:cap-test',
    terminal_capability: 'termcap:no-local-terminal',
  })
  assert.equal(killed.ok, true)
  assert.equal(killed.already_unavailable, true)
  assert.equal(calls.length, 0)
}

{
  const missing = Object.assign(new Error('no session'), { stderr: 'no session: daemon-local-tmux-gone' })
  const { rpc, calls } = createRpc({
    ledgerRow: {
      id: 'fleet:cap-test',
      terminalCapability: 'termcap:gone',
      sessionId: 'rollout-gone',
      tmuxSession: 'daemon-local-tmux-gone',
      daemonKey: 'mini:prod',
    },
    killSessionError: missing,
  })
  const killed = await rpc.handlers['kill-session']({
    agent_id: 'fleet:cap-test',
    terminal_capability: 'termcap:gone',
  })
  assert.equal(killed.ok, true)
  assert.equal(killed.already_unavailable, true)
  assert.equal(killed.reason, 'tmux session already absent')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['kill-session', '-t', 'daemon-local-tmux-gone'])
}

{
  const refused = Object.assign(new Error('permission denied'), { stderr: 'permission denied' })
  const { rpc } = createRpc({
    ledgerRow: {
      id: 'fleet:cap-test',
      terminalCapability: 'termcap:refused',
      sessionId: 'rollout-refused',
      tmuxSession: 'daemon-local-tmux-refused',
      daemonKey: 'mini:prod',
    },
    killSessionError: refused,
  })
  await assert.rejects(
    () => rpc.handlers['kill-session']({
      agent_id: 'fleet:cap-test',
      terminal_capability: 'termcap:refused',
    }),
    /permission denied/,
  )
}

{
  const messages = []
  const ptyModule = fakePtyModule()
  let visibleSnapshot = 'first visible screen\n'
  const ledgerRow = {
    id: 'fleet:cap-test',
    terminalCapability: 'termcap:live',
    sessionId: 'rollout-live',
    tmuxSession: 'daemon-local-tmux-live',
    daemonKey: 'mini:prod',
  }
  const { rpc, calls } = createRpc({
    ledgerRow,
    sendMsg: msg => messages.push(msg),
    ptyModuleImpl: ptyModule,
    terminalStdout: ({ args }) => args.includes('display-message') ? '120 40\n' : visibleSnapshot,
  })

  await rpc.handlers['start-terminal-watch']({
    agent_id: 'fleet:cap-test',
    terminal_capability: 'termcap:live',
  })
  visibleSnapshot = 'second viewer current screen\n'
  const second = await rpc.handlers['start-terminal-watch']({
    agent_id: 'fleet:cap-test',
    terminal_capability: 'termcap:live',
  })
  await rpc.handlers['stop-terminal-watch']({
    agent_id: 'fleet:cap-test',
    terminal_capability: 'termcap:live',
  })

  assert.equal(second.already, true)
  assert.equal(ptyModule.ptys.length, 1, 'watch reuse should keep one PTY per tmux session')
  const dataMessages = messages.filter(msg => msg.type === 'terminal-data')
  assert.equal(dataMessages.length, 2, 'second subscriber must receive a current terminal snapshot')
  assert.equal(Buffer.from(dataMessages[0].data, 'base64').toString(), 'first visible screen\r\n')
  assert.equal(Buffer.from(dataMessages[1].data, 'base64').toString(), 'second viewer current screen\r\n')
  const seedCaptures = calls.filter(call => call.args.includes('capture-pane') && call.args.includes('daemon-local-tmux-live'))
  assert.equal(seedCaptures.length, 2, 'each subscriber attach should capture the current pane once')
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-terminal-capability-ledger-'))
  const ledger = createPermissionLedger(path.join(dir, 'permissions.db'))
  try {
    ledger.setSyncForTest('fleet:cap-test', { permissionGrant: 'ops', permissionGrant: 'test' })
    ledger.setSessionSync('fleet:cap-test', {
      sessionId: 'rollout-one',
      sessionKind: 'codex',
      tmuxSession: 'daemon-local-tmux-one',
      daemonKey: 'mini:prod',
    })
    const first = ledger.rotateTerminalCapabilitySync('fleet:cap-test')
    assert.equal(ledger.resolveTerminalCapability({ agentId: 'fleet:cap-test', terminalCapability: first })?.tmuxSession, 'daemon-local-tmux-one')
    const second = ledger.rotateTerminalCapabilitySync('fleet:cap-test')
    assert.notEqual(first, second)
    assert.equal(ledger.resolveTerminalCapability({ agentId: 'fleet:cap-test', terminalCapability: first }), null)
    assert.equal(ledger.resolveTerminalCapability({ agentId: 'fleet:cap-test', terminalCapability: second })?.tmuxSession, 'daemon-local-tmux-one')
  } finally {
    await ledger.close()
  }
}

console.log('terminal-capability-routing-test: ok')
