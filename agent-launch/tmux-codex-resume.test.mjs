import assert from 'node:assert/strict'
import test from 'node:test'

import { injectCodexPrompt } from './tmux.mjs'

test('Codex prompt injection ignores startup warnings in a resumed transcript', async () => {
  const prompt = 'Call login() and check your inbox.'
  let pane = [
    'Warning: MCP startup interrupted. The following servers were not initialized: tlda',
    '',
    '› Summarize recent commits',
  ].join('\n')
  const sent = []
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: pane }
    assert.equal(command, 'send-keys')
    sent.push(args)
    const literalIndex = args.indexOf('-l')
    if (literalIndex >= 0) pane += args[literalIndex + 1]
    return { stdout: '' }
  }

  const delivered = await injectCodexPrompt('fleet-agent', prompt, {
    timeoutMs: 1000,
    tmuxExec,
    sleep: async () => {},
  })

  assert.equal(delivered, true)
  assert.equal(sent.some(args => args.at(-1) === 'Enter'), true)
})

test('Codex prompt injection dismisses the update dialog before kickoff', async () => {
  const prompt = 'Call login() and check your inbox.'
  let pane = [
    '✨ Update available! 0.147.0 -> 0.149.0',
    '1. Update now',
    '› 2. Skip',
    '3. Skip until next version',
    'Press enter to continue',
  ].join('\n')
  const sent = []
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: pane }
    assert.equal(command, 'send-keys')
    sent.push(args)
    if (args.at(-1) === 'Enter' && sent.some(call => call.at(-1) === '2')) pane = '› Summarize recent commits'
    const literalIndex = args.indexOf('-l')
    if (literalIndex >= 0) pane += args[literalIndex + 1]
    return { stdout: '' }
  }

  const delivered = await injectCodexPrompt('fleet-agent', prompt, {
    timeoutMs: 1000,
    tmuxExec,
    sleep: async () => {},
  })

  assert.equal(delivered, true)
  assert.equal(sent[0].at(-1), '2')
  assert.equal(sent[1].at(-1), 'Enter')
  assert.equal(sent.at(-1).at(-1), 'Enter')
})
