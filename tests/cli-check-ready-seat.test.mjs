import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { collectAgentReadiness } from '../cli/tlda.mjs'

function stateAgent(overrides = {}) {
  return {
    id: 'fleet:66660cc3',
    friendly_name: 'icantevengetafuckinglist',
    tmux_session: 'fleet-liveness',
    dead: false,
    metadata: { kind: 'codex' },
    ...overrides,
  }
}

test('check-ready treats registry/current-seat tmux mismatch as diagnostic only', async () => {
  let tmuxCalled = false
  const result = await collectAgentReadiness('fleet:66660cc3', (cmd, args) => {
    tmuxCalled = true
    if (cmd === 'tmux' && args.includes('has-session')) return { status: 0, stdout: '' }
    if (cmd === 'tmux' && args.includes('list-panes')) return { status: 0, stdout: '123\n' }
    if (cmd === 'ps') return { status: 0, stdout: '123 1 codex -m gpt-5.5\n' }
    return { status: 0, stdout: '123\n' }
  }, async (_method, url) => {
    if (url === '/api/state') return { agents: [stateAgent()] }
    if (url.startsWith('/api/agent-seat')) {
      return {
        seat: {
          agent_id: 'fleet:66660cc3',
          session_id: '019f6034-correct',
          daemon_key: 'mini:fly',
          tmux_session: 'fleet-icantevengetafuckinglist',
        },
      }
    }
    if (url.startsWith('/api/fleet-table')) return { agents: [{ id: 'fleet:66660cc3', status: 'awake' }] }
    if (url.startsWith('/api/store/events')) {
      return { events: [{ id: 1, type: 'login', timestamp: new Date().toISOString(), from: 'fleet:66660cc3' }] }
    }
    throw new Error(`unexpected API call ${url}`)
  })

  assert.equal(result.ok, true)
  assert.match(result.warning, /registry\/current-seat tmux mismatch/)
  assert.equal(tmuxCalled, true)
})

test('check-ready uses current durable seat tmux for runtime proof', async () => {
  const calls = []
  const result = await collectAgentReadiness('fleet:66660cc3', (cmd, args) => {
    calls.push([cmd, args])
    if (cmd === 'tmux' && args.includes('has-session')) return { status: 0, stdout: '' }
    if (cmd === 'tmux' && args.includes('list-panes')) return { status: 0, stdout: '123\n' }
    if (cmd === 'ps') return { status: 0, stdout: '123 1 codex -m gpt-5.5\n' }
    return { status: 1, stdout: '' }
  }, async (_method, url) => {
    if (url === '/api/state') return { agents: [stateAgent({ tmux_session: null })] }
    if (url.startsWith('/api/agent-seat')) {
      return {
        seat: {
          agent_id: 'fleet:66660cc3',
          session_id: '019f6034-correct',
          daemon_key: 'mini:fly',
          tmux_session: 'fleet-icantevengetafuckinglist',
        },
      }
    }
    if (url.startsWith('/api/fleet-table')) return { agents: [{ id: 'fleet:66660cc3', status: 'awake' }] }
    if (url.startsWith('/api/store/events')) {
      return { events: [{ id: 1, type: 'login', timestamp: new Date().toISOString(), from: 'fleet:66660cc3' }] }
    }
    throw new Error(`unexpected API call ${url}`)
  })

  assert.equal(result.ok, true)
  assert.equal(result.session, 'fleet-icantevengetafuckinglist')
  assert.ok(calls.some(([, args]) => args.includes('fleet-icantevengetafuckinglist')))
})

test('MCP login rejects a requested agent id that conflicts with FLEET_ID', () => {
  const source = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
  assert.match(source, /boundFleetId && shellId !== boundFleetId/)
  assert.match(source, /Login rejected: requested/)
  assert.match(source, /session already bound/)
})
