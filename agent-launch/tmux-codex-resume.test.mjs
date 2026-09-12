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
    if (args.at(-1) === 'C-u') pane = pane.replace(/›[^\n]*$/, '› ')
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
    if (args.at(-1) === 'C-u') pane = pane.replace(/›[^\n]*(?=\n|$)/g, '› ')
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
    if (args.at(-1) === 'C-u') pane = pane.replace(/›[^\n]*$/, '› ')
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

test('Codex prompt injection does not redeliver when the submitted kickoff remains in transcript', async () => {
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

  let legacyPane = `› ${prompt}`
  let legacyEnterCount = 0
  for (let attempt = 0; attempt < 3; attempt += 1) {
    legacyEnterCount += 1
    legacyPane += '\n\n› Ask Codex to do anything'
    if (!legacyPane.includes(prompt.slice(0, 48))) break
  }
  assert.equal(legacyEnterCount, 3, 'the former whole-pane marker check resubmits against retained transcript')
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

test('Codex prompt injection waits for model loading to finish before one Enter', async () => {
  const prompt = 'Call login() and check your inbox.'
  let pane = 'model: loading\n› Summarize recent commits'
  let loadingCaptures = 0
  let enterCount = 0
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') {
      // Readiness arrives on its own schedule. It is NOT gated on the prompt
      // having been pasted: the injection waits for the model before pasting, so
      // a fake that only becomes ready once the composer is loaded would encode
      // the old order rather than test it.
      if (enterCount === 0 && pane.includes('model: loading')) {
        loadingCaptures += 1
        if (loadingCaptures === 3) pane += '\n\ngpt-5.6-sol default · ~/work/tlda'
      }
      return { stdout: pane }
    }
    assert.equal(command, 'send-keys')
    if (args.at(-1) === 'C-u') pane = pane.replace(/›[^\n]*(?=\n|$)/g, '› ')
    const literalIndex = args.indexOf('-l')
    if (literalIndex >= 0) pane = pane.replace(/›[^\n]*(?=\n|$)/g, (line) => line + args[literalIndex + 1])
    if (args.at(-1) === 'Enter') {
      assert.equal(pane.includes('gpt-5.6-sol default ·'), true)
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
  // It waited for the model. The exact number of captures is the polling
  // cadence rather than a property; the load-bearing claims are that Enter went
  // out once, and that the fake asserted a ready footer when it did.
  assert.ok(loadingCaptures >= 3, `expected to wait through loading, got ${loadingCaptures} captures`)
  assert.equal(enterCount, 1)
})

test('Codex prompt injection trusts the live ready footer over stale model-loading text', async () => {
  const prompt = 'Call login() and check your inbox.'
  let pane = 'model: loading\n\n› Summarize recent commits\n\ngpt-5.6-sol default · ~/work/tlda'
  assert.equal(pane.includes('model: loading'), true, 'the former whole-pane readiness check remains red')
  let enterCount = 0
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: pane }
    assert.equal(command, 'send-keys')
    if (args.at(-1) === 'C-u') pane = pane.replace(/›[^\n]*(?=\n|$)/g, '› ')
    const literalIndex = args.indexOf('-l')
    if (literalIndex >= 0) pane = pane.replace(/›[^\n]*(?=\n|$)/g, (line) => line + args[literalIndex + 1])
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

test('Codex prompt injection does not trust stale ready text over the live loading status', async () => {
  const prompt = 'Call login() and check your inbox.'
  let pane = 'gpt-5.6-sol default · ~/work/tlda\n\n› Summarize recent commits\n\nmodel: loading'
  let enterCount = 0
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: pane }
    assert.equal(command, 'send-keys')
    if (args.at(-1) === 'C-u') pane = pane.replace(/›[^\n]*(?=\n|$)/g, '› ')
    const literalIndex = args.indexOf('-l')
    if (literalIndex >= 0) pane = pane.replace(/›[^\n]*(?=\n|$)/g, (line) => line + args[literalIndex + 1])
    if (args.at(-1) === 'Enter') enterCount += 1
    return { stdout: '' }
  }

  const delivered = await injectCodexPrompt('fleet-agent', prompt, {
    timeoutMs: 20,
    tmuxExec,
    sleep: async () => {},
  })

  assert.equal(delivered, false)
  assert.equal(enterCount, 0)
})

// The failure this whole path exists to prevent: an injection that gives up
// must not leave the kickoff sitting in the composer. A parked prompt is
// indistinguishable from a dead mint from outside -- live process, live tmux
// session, no turn ever produced -- and it cost two agents a night.
test('Codex prompt injection that cannot confirm submission leaves no prompt in the composer', async () => {
  const prompt = 'Call login() and check your inbox.'
  // Ready to accept the paste, and then Enter never submits: the composer keeps
  // the prompt no matter how many times Enter goes out.
  let composer = 'Summarize recent commits'
  const pane = () => `› ${composer}\n\ngpt-5.6-sol default · ~/work/tlda`
  let enterCount = 0
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: pane() }
    assert.equal(command, 'send-keys')
    if (args.at(-1) === 'C-u') composer = ''
    const literalIndex = args.indexOf('-l')
    if (literalIndex >= 0) composer += args[literalIndex + 1]
    if (args.at(-1) === 'Enter') enterCount += 1
    return { stdout: '' }
  }

  const delivered = await injectCodexPrompt('fleet-agent', prompt, {
    timeoutMs: 1200,
    tmuxExec,
  })

  assert.equal(delivered, false, 'an unconfirmed submission is not a delivery')
  assert.ok(enterCount >= 1, 'it did try to submit')
  assert.equal(composer, '', 'the composer was cleared rather than left holding the kickoff')
})

test('Codex prompt injection presses no Enter while the model is still loading', async () => {
  const prompt = 'Call login() and check your inbox.'
  const pane = 'model: loading\n› Summarize recent commits'
  let enterCount = 0
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: pane }
    assert.equal(command, 'send-keys')
    if (args.at(-1) === 'Enter') enterCount += 1
    return { stdout: '' }
  }

  const delivered = await injectCodexPrompt('fleet-agent', prompt, {
    timeoutMs: 1000,
    tmuxExec,
    sleep: async () => {},
  })

  assert.equal(delivered, false)
  assert.equal(enterCount, 0)
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
