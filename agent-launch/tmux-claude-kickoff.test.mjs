import assert from 'node:assert/strict'
import test from 'node:test'

import { injectClaudePrompt } from './tmux.mjs'

// Fresh Claude mints carry the kickoff on argv, so only wake and resume reach
// this path. It used to `return true` immediately after the keypress, having
// looked at nothing -- which made a kickoff parked in the composer report as
// delivered and left the caller with no way to tell.

test('Claude prompt injection confirms the submission before reporting delivery', async () => {
  const prompt = 'Call login() and check your inbox.'
  let composer = ''
  const pane = () => `❯ ${composer}`
  let enterCount = 0
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: pane() }
    assert.equal(command, 'send-keys')
    if (args.at(-1) === 'C-u') composer = ''
    else if (args.at(-1) === 'Enter') {
      enterCount += 1
      composer = ''
    } else if (args.at(-1) === prompt) composer = prompt
    return { stdout: '' }
  }

  const delivered = await injectClaudePrompt('fleet-agent', prompt, {
    timeoutMs: 2000,
    tmuxExec,
    dialogGraceMs: 0,
    sleep: async () => {},
  })

  assert.equal(delivered, true)
  assert.equal(enterCount, 1)
})

test('Claude prompt injection that cannot confirm submission leaves no prompt in the composer', async () => {
  const prompt = 'Call login() and check your inbox.'
  // Enter never submits: the kickoff stays in the composer however often we try.
  let composer = ''
  const pane = () => `❯ ${composer}`
  let enterCount = 0
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: pane() }
    assert.equal(command, 'send-keys')
    if (args.at(-1) === 'C-u') composer = ''
    else if (args.at(-1) === 'Enter') enterCount += 1
    else if (args.at(-1) === prompt) composer = prompt
    return { stdout: '' }
  }

  const delivered = await injectClaudePrompt('fleet-agent', prompt, {
    timeoutMs: 1200,
    tmuxExec,
    dialogGraceMs: 0,
  })

  assert.equal(delivered, false, 'an unconfirmed submission is not a delivery')
  assert.ok(enterCount >= 1, 'it did try to submit')
  assert.equal(composer, '', 'the composer was cleared rather than left holding the kickoff')
})

test('Claude prompt injection reports delivery when the harness starts working', async () => {
  const prompt = 'Call login() and check your inbox.'
  let pane = '❯ '
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: pane }
    assert.equal(command, 'send-keys')
    if (args.at(-1) === prompt) pane = `❯ ${prompt}`
    // The composer keeps the text on screen and the harness starts below it.
    if (args.at(-1) === 'Enter') pane = `❯ ${prompt}\n\n✻ Thinking… (esc to interrupt)`
    return { stdout: '' }
  }

  const delivered = await injectClaudePrompt('fleet-agent', prompt, {
    timeoutMs: 2000,
    tmuxExec,
    dialogGraceMs: 0,
    sleep: async () => {},
  })

  assert.equal(delivered, true)
})
