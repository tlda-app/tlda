import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createTerminalRpc } from '../daemon/terminal-rpc.mjs'
import { decideTerminalWatchExit } from '../agent-runtime/daemon-guards.mjs'
import { createPermissionLedger } from '../agent-launch/permission-ledger.mjs'

function createRpc({ ledgerRow = null, killSessionError = null } = {}) {
  const calls = []
  const rpc = createTerminalRpc({
    tmuxArgs: [],
    log: { info() {}, warn() {}, error() {} },
    sendMsg() {},
    detectPrompt: () => ({ type: 'none' }),
    stripAnsi: s => s,
    promptCooldowns: new Map(),
    surfacedPrompts: new Map(),
    alivenessCache: new Map(),
    thinkingSpinnerRe: /$a/,
    interruptHintRe: /$a/,
    thinkingScanLines: 10,
    decideTerminalWatchExit: () => ({ terminalDead: true }),
    onArmAgent() {},
    onArmBySession() {},
    onEmitAgentStatus() {},
    onPlanModeSeen() {},
    onPlanModeGone() {},
    hasPlanMode: () => false,
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
      return { stdout: 'live terminal\n' }
    },
  })
  return { rpc, calls }
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
    terminal_capability: 'termcap:live',
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
  await rpc.handlers['send-key']({ agent_id: 'fleet:cap-test', terminal_capability: 'termcap:live', key: 'Enter' })
  await rpc.handlers['send-text']({ agent_id: 'fleet:cap-test', terminal_capability: 'termcap:live', text: 'hello', enter: true })
  await rpc.handlers['interrupt']({ agent_id: 'fleet:cap-test', terminal_capability: 'termcap:live' })
  const soft = await rpc.handlers['soft-interrupt']({ agent_id: 'fleet:cap-test', terminal_capability: 'termcap:live' })
  const alive = await rpc.handlers['check-alive']({ agent_id: 'fleet:cap-test', terminal_capability: 'termcap:live' })

  assert.equal(soft.ok, true)
  assert.equal(alive.alive, true)
  assert(calls.some(call => call.args.includes('send-keys') && call.args.includes('Enter')))
  assert(calls.every(call => call.args.includes('daemon-local-tmux-live') || call.args.includes('list-sessions')))
}

for (const [name, payload] of [
  ['send-key', { key: 'Enter' }],
  ['send-text', { text: 'hello' }],
  ['capture-pane', { lines: 5 }],
  ['interrupt', {}],
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

  await assert.rejects(
    () => rpc.handlers['capture-pane']({
      agent_id: 'fleet:cap-test',
      terminal_capability: 'termcap:old-incarnation',
      lines: 5,
    }),
    /terminal capability unavailable/,
  )
  assert.equal(calls.length, 0)
}

{
  const { rpc, calls } = createRpc()
  await assert.rejects(
    () => rpc.handlers['capture-pane']({
      agent_id: 'fleet:cap-test',
      terminal_capability: 'termcap:wrong-daemon',
      lines: 5,
    }),
    /terminal capability unavailable/,
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
    /terminal capability unavailable/,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-terminal-capability-ledger-'))
  const ledger = createPermissionLedger(path.join(dir, 'permissions.db'))
  try {
    ledger.setSyncForTest('fleet:cap-test', { spawnPolicy: { policy: 'unsandboxed' }, permissionProfile: 'test' })
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
