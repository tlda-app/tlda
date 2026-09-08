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
    if (args.at(-1) === 'Enter' && pane.includes(prompt)) pane += '\n\n• Working (0s • esc to interrupt)'
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
    if (args.at(-1) === 'Enter' && pane.includes('Update available!') && sent.some(call => call.at(-1) === '2')) pane = '› Summarize recent commits'
    const literalIndex = args.indexOf('-l')
    if (literalIndex >= 0) pane += args[literalIndex + 1]
    if (args.at(-1) === 'Enter' && pane.includes(prompt)) pane += '\n\n• Working (0s • esc to interrupt)'
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

test('Codex prompt injection ignores an update dialog left in scrollback', async () => {
  const prompt = 'Call login() and check your inbox.'
  let pane = [
    'Update available!',
    '3. Skip until next version',
    'Press enter to continue',
    ...Array.from({ length: 21 }, (_, i) => `old output ${i}`),
    '› Summarize recent commits',
  ].join('\n')
  const sent = []
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: pane }
    assert.equal(command, 'send-keys')
    sent.push(args)
    const literalIndex = args.indexOf('-l')
    if (literalIndex >= 0) pane += args[literalIndex + 1]
    if (args.at(-1) === 'Enter' && pane.includes(prompt)) pane += '\n\n• Working (0s • esc to interrupt)'
    return { stdout: '' }
  }

  const delivered = await injectCodexPrompt('fleet-agent', prompt, {
    timeoutMs: 1000,
    tmuxExec,
    sleep: async () => {},
  })

  assert.equal(delivered, true)
  assert.equal(sent[0].at(-1), 'C-u')
  assert.equal(sent.some(args => args.at(-1) === '2'), false)
})

test('Codex prompt injection sends Enter once when the submitted kickoff remains in transcript', async () => {
  const prompt = 'Call login() and check your inbox.'
  let pane = '› Summarize recent commits'
  let enterCount = 0
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: pane }
    assert.equal(command, 'send-keys')
    const literalIndex = args.indexOf('-l')
    if (literalIndex >= 0) pane += args[literalIndex + 1]
    if (args.at(-1) === 'Enter') {
      enterCount += 1
      pane += '\n\n› Ask Codex to do anything'
    }
    return { stdout: '' }
  }

  const delivered = await injectCodexPrompt('fleet-agent', prompt, {
    timeoutMs: 1000,
    tmuxExec,
    sleep: async () => {},
  })

  assert.equal(delivered, true)
  assert.equal(enterCount, 1)
})

test('Codex prompt injection observes Working after one Enter without sending more input', async () => {
  const prompt = 'Call login() and check your inbox.'
  let pane = '› Summarize recent commits'
  let enterCount = 0
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: pane }
    assert.equal(command, 'send-keys')
    const literalIndex = args.indexOf('-l')
    if (literalIndex >= 0) pane += args[literalIndex + 1]
    if (args.at(-1) === 'Enter') {
      enterCount += 1
      pane += '\n\n• Working (0s • esc to interrupt)'
    }
    return { stdout: '' }
  }

  const delivered = await injectCodexPrompt('fleet-agent', prompt, {
    timeoutMs: 1000,
    tmuxExec,
    sleep: async () => {},
  })

  assert.equal(delivered, true)
  assert.equal(enterCount, 1)
})

test('Codex prompt injection accepts a kickoff that completes before the post-Enter capture', async () => {
  const prompt = 'Call login() and check your inbox.'
  let pane = '› Ask Codex to do anything'
  let enterCount = 0
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: pane }
    assert.equal(command, 'send-keys')
    const literalIndex = args.indexOf('-l')
    if (literalIndex >= 0) pane += args[literalIndex + 1]
    if (args.at(-1) === 'Enter') {
      enterCount += 1
      pane = '› Ask Codex to do anything'
    }
    return { stdout: '' }
  }

  const delivered = await injectCodexPrompt('fleet-agent', prompt, {
    timeoutMs: 1000,
    tmuxExec,
    sleep: async () => {},
  })

  assert.equal(delivered, true)
  assert.equal(enterCount, 1)
})

test('Codex prompt injection does not infer delivery from a failed post-Enter capture', async () => {
  const prompt = 'Call login() and check your inbox.'
  let pane = '› Ask Codex to do anything'
  let failCapture = false
  let enterCount = 0
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') {
      if (failCapture) throw new Error('capture failed')
      return { stdout: pane }
    }
    assert.equal(command, 'send-keys')
    const literalIndex = args.indexOf('-l')
    if (literalIndex >= 0) pane += args[literalIndex + 1]
    if (args.at(-1) === 'Enter') {
      enterCount += 1
      failCapture = true
    }
    return { stdout: '' }
  }

  const delivered = await injectCodexPrompt('fleet-agent', prompt, {
    timeoutMs: 10,
    tmuxExec,
    sleep: async () => new Promise(resolve => setTimeout(resolve, 1)),
  })

  assert.equal(delivered, false)
  assert.equal(enterCount, 1)
})
