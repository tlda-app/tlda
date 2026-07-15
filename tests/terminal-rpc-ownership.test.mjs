import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

function wsHandlerBlock(source, type) {
  const start = source.indexOf(`if (type === '${type}')`)
  assert.notEqual(start, -1, `missing websocket handler for ${type}`)
  const end = source.indexOf('\n  // ---- ', start + 1)
  return source.slice(start, end === -1 ? undefined : end)
}

test('fleet websocket terminal controls route through the current durable seat', () => {
  const source = readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  for (const type of [
    'kill-session',
    'hibernate-session',
    'interrupt',
    'send-key',
    'send-text',
    'capture-pane',
    'check-alive',
    'plan-mode-respond',
    'plan-mode-toggle',
  ]) {
    const block = wsHandlerBlock(source, type)
    assert.match(block, /currentSeatOrError\(agent\)/, `${type} must resolve current durable seat`)
    assert.match(block, /sendRpc\(seat\.daemon_key,/, `${type} must route through current daemon key`)
    assert.match(block, /session_id: seat\.session_id/, `${type} must pass exact session id`)
    assert.match(block, /tmux_session: seat\.tmux_session/, `${type} must pass exact current tmux session`)
    assert.doesNotMatch(block, /resolveRpc\([^)]*agent\)/, `${type} must not route from legacy agent row`)
    assert.doesNotMatch(block, /agent\.tmux_session/, `${type} must not gate on legacy agent tmux session`)
  }
})

test('terminal card paths require the current durable seat identity tuple', () => {
  const unified = readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const wsBlock = wsHandlerBlock(unified, 'terminal-card')
  assert.match(wsBlock, /currentSeatOrError\(agent\)/)
  assert.match(wsBlock, /session_id: seat\.session_id/)
  assert.match(wsBlock, /tmux_session: seat\.tmux_session/)
  assert.doesNotMatch(wsBlock, /agent\.tmux_session/)
  assert.doesNotMatch(wsBlock, /agent\.machine_id/)

  const routeSource = readFileSync(new URL('../server/routes/fleet.mjs', import.meta.url), 'utf8')
  assert.match(routeSource, /function currentSeatOrHttpError[\s\S]*!seat\.daemon_key \|\| !seat\.tmux_session \|\| !seat\.session_id/)
  const httpStart = routeSource.indexOf("router.post('/api/terminal-card'")
  assert.notEqual(httpStart, -1, 'missing HTTP terminal-card route')
  const httpEnd = routeSource.indexOf("\n  // --- POST /api/wiretap", httpStart)
  const httpBlock = routeSource.slice(httpStart, httpEnd)
  assert.match(httpBlock, /currentSeatOrHttpError\(res, agent\)/)
  assert.match(httpBlock, /session_id: seat\.session_id/)
  assert.match(httpBlock, /tmux_session: seat\.tmux_session/)
  assert.doesNotMatch(httpBlock, /agent\.tmux_session/)
  assert.doesNotMatch(httpBlock, /agent\.machine_id/)
})

test('generic agent edit surfaces cannot mutate identity or runtime route fields', () => {
  const unified = readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const updateBlock = wsHandlerBlock(unified, 'update-agent')
  assert.match(updateBlock, /protectedAgentEditFields\(agentData\)/)
  assert.match(updateBlock, /Cannot edit immutable identity\/runtime route fields/)
  assert.ok(updateBlock.indexOf('protectedAgentEditFields(agentData)') < updateBlock.indexOf('fleetStore.upsertAgent(agentData)'))

  for (const field of [
    'session_id',
    'session_ids',
    'resume_id',
    'kind',
    'model',
    'cwd',
    'machine_id',
    'env_name',
    'daemon_key',
    'tmux_session',
  ]) {
    assert.match(unified, new RegExp(`'${field}'`), `${field} must be protected from generic updates`)
  }

  const routeSource = readFileSync(new URL('../server/routes/fleet.mjs', import.meta.url), 'utf8')
  const moveStart = routeSource.indexOf("router.post('/api/agents/move-daemon'")
  assert.notEqual(moveStart, -1, 'missing move-daemon route')
  const moveEnd = routeSource.indexOf("\n  // --- POST /api/agent-status", moveStart)
  const moveBlock = routeSource.slice(moveStart, moveEnd)
  assert.match(moveBlock, /status\(410\)/)
  assert.match(moveBlock, /durable seat binding event path/)
  assert.doesNotMatch(moveBlock, /upsertAgent/)
})

test('fresh shell reservation does not generic-upsert an empty session history', () => {
  const unified = readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  const start = unified.indexOf("if (type === 'register' || type === 'reserve-shell')")
  const end = unified.indexOf("\n  // Login has two forms:", start)
  assert.notEqual(start, -1, 'missing registration handler')
  assert.notEqual(end, -1, 'missing registration handler endpoint')
  const registerBlock = unified.slice(start, end)

  assert.match(registerBlock, /session_ids: existing\?\.session_ids,/)
  assert.doesNotMatch(registerBlock, /session_ids: existing\?\.session_ids \|\| \[\]/)
  assert.match(registerBlock, /session_id\/session_ids are minted by the durable seat binding path/)
})
