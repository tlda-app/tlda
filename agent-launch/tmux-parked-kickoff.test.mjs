import assert from 'node:assert/strict'
import test from 'node:test'

import { submitParkedKickoff } from './tmux.mjs'

const KICKOFF = '💻 Call login() with the tlda MCP server. Then call inbox() to check for a pending task.'

// A live process whose composer still holds our kickoff has never produced a
// turn. `wake` used to report that agent as already awake, which is the report
// that stops people looking.
function fakePane({ composer = '', busy = false, prompt = '›', onEnter = () => {} } = {}) {
  const sent = []
  let current = composer
  let working = busy
  const pane = () => [
    'To get started, describe a task or try one of these commands:',
    '',
    `${prompt} ${current}`,
    ...(working ? ['• Working (0s • esc to interrupt)'] : []),
  ].join('\n')
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: pane() }
    sent.push(args.at(-1))
    if (args.at(-1) === 'Enter') {
      const next = onEnter()
      if (next === 'submitted') { current = ''; working = true }
    }
    return { stdout: '' }
  }
  return { tmuxExec, sent, composer: () => current }
}

test('a parked kickoff is submitted and reported as recovered', async () => {
  const fake = fakePane({ composer: KICKOFF, onEnter: () => 'submitted' })

  const result = await submitParkedKickoff('fleet-agent', 'codex', KICKOFF, {
    tmuxExec: fake.tmuxExec,
    sleep: async () => {},
  })

  assert.equal(result.observed, true)
  assert.equal(result.parked, true)
  assert.equal(result.submitted, true)
  assert.equal(fake.sent.filter(key => key === 'Enter').length, 1)
  assert.ok(result.pane.includes(KICKOFF), 'it carries the pane it read, for showing')
  assert.ok(result.observedAt, 'and when it read it')
})

test('a kickoff that will not submit is reported unsubmitted and left in the composer', async () => {
  // Nothing else holds the kickoff text. Clearing it here would destroy the only
  // copy of what the agent was asked to do -- so this is the one path that must
  // NOT clear, unlike an injection that gives up before the agent exists.
  const fake = fakePane({ composer: KICKOFF, onEnter: () => 'ignored' })

  const result = await submitParkedKickoff('fleet-agent', 'codex', KICKOFF, {
    tmuxExec: fake.tmuxExec,
    confirmMs: 1200,
  })

  assert.equal(result.parked, true)
  assert.equal(result.submitted, false)
  assert.equal(fake.composer(), KICKOFF, 'the kickoff is still there to be read and retried')
})

test('a composer holding something other than our kickoff is not submitted', async () => {
  const fake = fakePane({ composer: 'half a sentence someone was typing' })

  const result = await submitParkedKickoff('fleet-agent', 'codex', KICKOFF, {
    tmuxExec: fake.tmuxExec,
    sleep: async () => {},
  })

  assert.equal(result.observed, true)
  assert.equal(result.parked, false)
  assert.equal(result.submitted, false)
  assert.equal(fake.sent.length, 0, 'no keypress went to a composer that was not ours')
})

test('a working harness is not interrupted', async () => {
  const fake = fakePane({ composer: KICKOFF, busy: true })

  const result = await submitParkedKickoff('fleet-agent', 'codex', KICKOFF, {
    tmuxExec: fake.tmuxExec,
    sleep: async () => {},
  })

  assert.equal(result.parked, false)
  assert.equal(fake.sent.length, 0)
})

test('a claude composer is read through the plain session target', async () => {
  const fake = fakePane({ composer: KICKOFF, prompt: '❯', onEnter: () => 'submitted' })

  const result = await submitParkedKickoff('fleet-agent', 'claude', KICKOFF, {
    tmuxExec: fake.tmuxExec,
    sleep: async () => {},
  })

  assert.equal(result.parked, true)
  assert.equal(result.submitted, true)
})

test('a pane that cannot be read is not reported as a healthy agent', async () => {
  const result = await submitParkedKickoff('fleet-agent', 'codex', KICKOFF, {
    tmuxExec: async () => { throw new Error('no server running') },
    sleep: async () => {},
  })

  assert.equal(result.observed, false, 'a failed look is the absence of evidence, not evidence of health')
  assert.equal(result.parked, false)
  assert.match(result.error, /no server running/)
})

// A composer rendering text next to the prompt is either PENDING INPUT or a dim
// ghost -- a restored unsent draft, or the harness's placeholder. `capture-pane
// -p` strips the attributes that tell them apart, so these fixtures carry the
// real bytes measured off a codex pane on 2026-09-12:
//
//   empty:  ESC[1m>ESC[0m ESC[2mAsk Codex to do anythingESC[0m
//   typed:  ESC[1m>ESC[0m Call login() ...
const ESC = '\x1b'
const ghostPane = (text) => `${ESC}[1m›${ESC}[0m ${ESC}[2m${text}${ESC}[0m\n  gpt-6-astra default · /tmp`
const livePane = (text) => `${ESC}[1m›${ESC}[0m ${text}\n  gpt-6-astra default · /tmp`

test('a dim GHOST of the kickoff is not treated as a parked kickoff', async () => {
  // The dangerous case: the composer shows our kickoff, but the buffer is empty.
  // Pressing Enter there does nothing, and reporting `parked` would name a
  // healthy agent as one that never started.
  const sent = []
  const tmuxExec = async (_s, command, ...args) => {
    if (command === 'capture-pane') {
      assert.ok(args.includes('-e'), 'it must ask for attributes, or it cannot tell ghost from input')
      return { stdout: ghostPane(KICKOFF) }
    }
    sent.push(args.at(-1))
    return { stdout: '' }
  }

  const result = await submitParkedKickoff('s', 'codex', KICKOFF, { tmuxExec, sleep: async () => {} })

  assert.equal(result.observed, true)
  assert.equal(result.parked, false, 'a ghost is not a parked kickoff')
  assert.deepEqual(sent, [], 'and nothing is pressed at an empty buffer')
})

test('a real pending kickoff is still recognised through the attribute capture', async () => {
  // The control for the test above: same capture path, same fixtures, live text.
  let composerText = KICKOFF
  const sent = []
  const tmuxExec = async (_s, command, ...args) => {
    if (command === 'capture-pane') return { stdout: composerText ? livePane(composerText) : ghostPane('Ask Codex to do anything') }
    sent.push(args.at(-1))
    if (args.at(-1) === 'Enter') composerText = ''
    return { stdout: '' }
  }

  const result = await submitParkedKickoff('s', 'codex', KICKOFF, { tmuxExec, sleep: async () => {} })

  assert.equal(result.parked, true)
  assert.equal(result.submitted, true)
  assert.deepEqual(sent, ['Enter'])
})

test('the harness placeholder is never mistaken for our kickoff', async () => {
  const fake = { tmuxExec: async (_s, command) => ({ stdout: command === 'capture-pane' ? ghostPane('Ask Codex to do anything') : '' }) }
  const result = await submitParkedKickoff('s', 'codex', KICKOFF, { ...fake, sleep: async () => {} })
  assert.equal(result.parked, false)
})
