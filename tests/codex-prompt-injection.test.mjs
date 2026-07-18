import assert from 'node:assert/strict'
import test from 'node:test'
import { injectCodexPrompt } from '../agent-launch/tmux.mjs'

function harness(panes) {
  const calls = []
  let capture = 0
  const tmuxExec = async (_socket, command, ...args) => {
    calls.push([command, ...args])
    if (command === 'capture-pane') return { stdout: panes[Math.min(capture++, panes.length - 1)] }
    return { stdout: '' }
  }
  return { calls, tmuxExec, sleep: async () => {} }
}

test('Codex injection waits through trust, MCP loading, and busy before ready without Escape', async () => {
  const prompt = 'Call login() and inbox()'
  const h = harness([
    'Do you trust the contents of this directory?',
    'Starting MCP servers\n›',
    'Working (esc to interrupt)\n›',
    '›',
    `› ${prompt}`,
  ])
  assert.equal(await injectCodexPrompt('fleet-test', prompt, { timeoutMs: 5000, ...h }), true)
  const keys = h.calls.filter(([cmd]) => cmd === 'send-keys').map(([, ...args]) => args.at(-1))
  assert.deepEqual(keys, ['Enter', 'C-u', prompt, 'Enter'])
  assert.equal(keys.includes('Escape'), false)
})

for (const failure of ['MCP startup cancelled', 'MCP startup interrupted']) {
  test(`Codex injection fails on ${failure} without sending keys`, async () => {
    const h = harness([failure])
    assert.equal(await injectCodexPrompt('fleet-test', 'prompt', { timeoutMs: 5000, ...h }), false)
    assert.equal(h.calls.some(([cmd]) => cmd === 'send-keys'), false)
  })
}

test('Codex injection does not inject while only MCP-loading state is observed', async () => {
  let now = 0
  const originalNow = Date.now
  Date.now = () => now
  try {
    const h = harness(['Starting MCP servers\n›'])
    h.sleep = async (ms) => { now += ms }
    assert.equal(await injectCodexPrompt('fleet-test', 'prompt', { timeoutMs: 2000, ...h }), false)
    assert.equal(h.calls.some(([cmd]) => cmd === 'send-keys'), false)
  } finally {
    Date.now = originalNow
  }
})
