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

// TWO dim renderings near the prompt, meaning opposite things. Measured by
// `notify-does-not-wake` and confirmed against a live claude pane, which renders
// its own prompt as ESC[38;5;246m — grey, not SGR 2. Conflating them is what made
// an earlier "19 agents are stuck" count a sum of two different states.
test('placeholders are rejected, and a queued prompt is not', async () => {
  const K = KICKOFF
  const cases = [
    ['SGR 2 dim, the codex ghost', `${ESC}[1m❯${ESC}[0m ${ESC}[2m${K}${ESC}[0m`, false],
    // Claude's real placeholder, measured off a live pane: SGR 2, same as codex.
    ['SGR 2 dim, the claude placeholder', `${ESC}[39m❯ ${ESC}[2mTry "refactor fleet-daemon.mjs"${ESC}[0m`, false],
    // Grey wraps the prompt GLYPH on an empty composer, not ghost text -- which
    // is why the greyscale range was reverted. No marker here, so: not parked.
    ['grey prompt glyph, empty composer', `${ESC}[38;5;246m❯ ${ESC}[39m`, false],
    // A highlighted BLOCK is a genuinely queued, unconsumed prompt -- real work
    // waiting, and for this function exactly the state worth acting on.
    ['highlight block 237, a queued prompt', `${ESC}[1m❯${ESC}[0m ${ESC}[48;5;237m${K}${ESC}[0m`, true],
    ['plain real input', `${ESC}[1m❯${ESC}[0m ${K}`, true],
    // The control that keeps the greyscale range honest: if this stripped all
    // 38;5; spans, coloured real input would read as a ghost.
    ['coloured real input', `${ESC}[1m❯${ESC}[0m ${ESC}[38;5;51m${K}${ESC}[39m`, true],
  ]

  for (const [label, pane, expectParked] of cases) {
    const sent = []
    const tmuxExec = async (_s, command, ...args) => {
      if (command === 'capture-pane') return { stdout: `${pane}\n  claude` }
      sent.push(args.at(-1))
      return { stdout: '' }
    }
    const result = await submitParkedKickoff('s', 'claude', K, { tmuxExec, sleep: async () => {}, confirmMs: 10 })
    assert.equal(result.parked, expectParked, label)
    assert.equal(sent.length > 0, expectParked, `${label}: keys sent only when it is real`)
  }
})

// A PANE-CONTENT MATCH AND A KEYSTROKE TARGET ARE DIFFERENT ADDRESSES.
// Measured by `notify-does-not-wake` on a probe carrying three queued kickoff
// prompts AND a dev-channels dialog. The classifier was right -- the span was on
// the queued prompts -- and Enter would still have gone to the dialog, whose
// highlighted default was "I am using this for local development".
const DEV_CHANNELS_DIALOG = [
  'WARNING: Loading development channels',
  '  --dangerously-load-development-channels is for local channel development only.',
  '  ❯ 1. I am using this for local development',
  '    2. Exit',
  '  Enter to confirm · Esc to cancel',
].join('\n')

test('a queued kickoff with a dialog up is reported, never answered', async () => {
  // The DANGEROUS arrangement: the composer is the last `❯` line, so the
  // classifier matches our kickoff and the old code would have sent Enter --
  // straight into the dialog, because focus is not where the text is.
  //
  // (With the dialog rendered BELOW, its own `❯ 1.` selection marker becomes the
  // last `❯` line and the match fails by accident. That accident is not a
  // safeguard, which is why the guard exists and why this fixture is ordered
  // this way.)
  const queued = `${ESC}[1m❯${ESC}[0m ${ESC}[48;5;237m${KICKOFF}${ESC}[0m`
  const sent = []
  const tmuxExec = async (_s, command, ...args) => {
    if (command === 'capture-pane') return { stdout: `${DEV_CHANNELS_DIALOG}\n${queued}` }
    sent.push(args.at(-1))
    return { stdout: '' }
  }

  const result = await submitParkedKickoff('s', 'claude', KICKOFF, { tmuxExec, sleep: async () => {} })

  assert.equal(result.parked, true, 'the kickoff really is waiting')
  assert.equal(result.blockedByDialog, true, 'and it says why it did not act')
  assert.equal(result.submitted, false)
  assert.deepEqual(sent, [], 'NOTHING was pressed while a dialog we cannot read has focus')
})

test('the same queued kickoff without a dialog is submitted', async () => {
  // Control for the test above: identical composer, dialog removed. Without this
  // the guard could refuse everything and still look correct.
  let composerText = KICKOFF
  const sent = []
  const tmuxExec = async (_s, command, ...args) => {
    if (command === 'capture-pane') {
      return { stdout: composerText ? `${ESC}[1m❯${ESC}[0m ${ESC}[48;5;237m${composerText}${ESC}[0m\n  claude` : `${ESC}[1m❯${ESC}[0m \n  claude` }
    }
    sent.push(args.at(-1))
    if (args.at(-1) === 'Enter') composerText = ''
    return { stdout: '' }
  }

  const result = await submitParkedKickoff('s', 'claude', KICKOFF, { tmuxExec, sleep: async () => {} })

  assert.equal(result.parked, true)
  assert.equal(result.submitted, true)
  assert.deepEqual(sent, ['Enter'])
})
