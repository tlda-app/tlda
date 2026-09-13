import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.FLEET_ID = 'fleet:test-agent'
const CONFIG_DIR_FIXTURE = mkdtempSync(join(tmpdir(), 'muse-notice-bindings-'))
process.env.TLDA_CONFIG_DIR = CONFIG_DIR_FIXTURE
process.env.TLDA_ENV = 'muse-notice-test'
writeFileSync(join(CONFIG_DIR_FIXTURE, 'daemon.yaml'), [
  'environments:',
  '  default: muse-notice-test',
  '  values:',
  '    muse-notice-test:',
  '      database: http://127.0.0.1:1',
  '      store: http://127.0.0.1:1',
  '      licenseKey: ""',
  '',
].join('\n'))

const { deliverChannelNotice } = await import('./fleet-tools.mjs')

// The pane runs `read` and echoes what it got behind a marker, so the assertion
// is that the line was SUBMITTED, not merely that the characters are sitting in
// the pane. That distinction is the whole subject: a lost Enter leaves the text
// visible and unsent, which reads exactly like a prompt someone is composing
// at, so an assertion on the text alone would pass for the very failure this
// case exists to prevent.
const PANE_MARKER = 'MUSE-PANE-RECEIVED:'

function startPane(name) {
  execFileSync('tmux', [
    'new-session', '-d', '-s', name,
    'sh', '-c', `read line; echo "${PANE_MARKER}$line"; sleep 30`,
  ], { timeout: 5000 })
  // Let the shell reach its `read` before anything is typed at it.
  execFileSync('sleep', ['0.3'])
}

function killPane(name) {
  try {
    execFileSync('tmux', ['kill-session', '-t', name], { timeout: 5000 })
  } catch {
    // Best-effort cleanup: the pane's `sleep 30` reaps it anyway, and throwing
    // here would replace a real assertion failure with a teardown one.
  }
}

function capture(name) {
  return execFileSync('tmux', ['capture-pane', '-p', '-t', name], { timeout: 5000, encoding: 'utf8' })
}

function waitForPane(name, needle, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let text = ''
  while (Date.now() < deadline) {
    text = capture(name)
    if (text.includes(needle)) return text
    execFileSync('sleep', ['0.1'])
  }
  return text
}

function tmuxAvailable() {
  try {
    execFileSync('tmux', ['-V'], { timeout: 5000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// `prepareFleetConfig` sets FLEET_HARNESS: 'muse', so harnessKindFromEnv()
// returns 'muse'. Before this case existed, every notification to a muse agent
// fell through to `default` and threw, and the handler answered the server's
// wake with `channel-error` -- so a muse agent only ever saw a message by
// polling its own inbox.
test('a muse notification is submitted into the agent pane', { skip: tmuxAvailable() ? false : 'tmux not available' }, async () => {
  const session = `muse-notice-test-${process.pid}`
  const previousHarness = process.env.FLEET_HARNESS
  const previousSession = process.env.FLEET_TMUX_SESSION
  startPane(session)
  process.env.FLEET_HARNESS = 'muse'
  process.env.FLEET_TMUX_SESSION = session

  try {
    const delivered = await deliverChannelNotice('📬 muse channel notice', { event_type: 'chat' })
    assert.equal(delivered, true)

    const pane = waitForPane(session, PANE_MARKER)
    assert.match(pane, new RegExp(`${PANE_MARKER}.*muse channel notice`))
  } finally {
    if (previousHarness === undefined) delete process.env.FLEET_HARNESS
    else process.env.FLEET_HARNESS = previousHarness
    if (previousSession === undefined) delete process.env.FLEET_TMUX_SESSION
    else process.env.FLEET_TMUX_SESSION = previousSession
    killPane(session)
  }
})

// The control for the assertion above: with no Enter, the same pane holds the
// same characters and the marker never appears. Without this, `PANE_MARKER`
// found in the capture could not be distinguished from the text simply being
// echoed as it was typed.
test('an unsubmitted line leaves the marker absent', { skip: tmuxAvailable() ? false : 'tmux not available' }, () => {
  const session = `muse-notice-control-${process.pid}`
  startPane(session)
  try {
    execFileSync('tmux', ['send-keys', '-t', session, '--', 'muse channel notice'], { timeout: 5000 })
    execFileSync('sleep', ['1.5'])
    const pane = capture(session)
    assert.match(pane, /muse channel notice/)
    assert.doesNotMatch(pane, new RegExp(PANE_MARKER))
  } finally {
    killPane(session)
  }
})
