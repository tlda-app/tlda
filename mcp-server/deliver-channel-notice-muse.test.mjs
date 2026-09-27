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
// Isolate pane locks (and park records) from every live agent.
process.env.TLDA_PANE_INPUT_DIR = mkdtempSync(join(tmpdir(), 'muse-wake-locks-'))
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

const {
  deliverChannelNotice,
  museComposerGhost,
  museSquatterKindStyled,
  __setFleetTransportForTest,
  __setMuseWakeLoopForTest,
  __museWakeLoopDrainedForTest,
} = await import('./fleet-tools.mjs')
const { acquirePaneInputLock } = await import('../shared/pane-input-lock.mjs')

// Scriptable unread level: the loop reads the server's canonical count.
let unreadScript = []
let unreadDefault = 0
__setFleetTransportForTest({
  ephemeral: async type => {
    if (type === 'unread-count') return { count: unreadScript.length ? unreadScript.shift() : unreadDefault }
    throw new Error(`unexpected transport call in muse wake test: ${type}`)
  },
})
// Fast retries, slow post-success recheck: tests observe the submit and flip
// the unread level inside the 2s window, so no second doorbell can race.
__setMuseWakeLoopForTest({ retryDelaysMs: [50, 50, 50], postSuccessDelayMs: 2000 })

const NOTICE = '📬 muse channel notice'

// The fixture pane presents muse's prompt glyph, reads one line, echoes it
// behind a marker, then presents a fresh prompt. A submitted line moves OFF
// the prompt line into the transcript above; the marker proves an Enter
// arrived, and its absence proves none did.
function startPane(name) {
  execFileSync('tmux', [
    'new-session', '-d', '-s', name,
    'sh', '-c', `printf '❯ '; read line; echo "MUSE-PANE-RECEIVED:$line"; printf '❯ '; sleep 30`,
  ], { timeout: 5000 })
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

function captureStyled(name) {
  return execFileSync('tmux', ['capture-pane', '-p', '-e', '-t', name], { timeout: 5000, encoding: 'utf8' })
}

function receivedCount(name) {
  return capture(name).split('MUSE-PANE-RECEIVED').length - 1
}

async function pollFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

function tmuxAvailable() {
  try {
    execFileSync('tmux', ['-V'], { timeout: 5000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const skipWithoutTmux = tmuxAvailable() ? false : 'tmux not available'

function useMusePane(session) {
  const previousHarness = process.env.FLEET_HARNESS
  const previousSession = process.env.FLEET_TMUX_SESSION
  process.env.FLEET_HARNESS = 'muse'
  process.env.FLEET_TMUX_SESSION = session
  return () => {
    if (previousHarness === undefined) delete process.env.FLEET_HARNESS
    else process.env.FLEET_HARNESS = previousHarness
    if (previousSession === undefined) delete process.env.FLEET_TMUX_SESSION
    else process.env.FLEET_TMUX_SESSION = previousSession
  }
}

// Ownership: the call accepts the wake (true) and the loop submits while
// unread persists, then drains when the count hits zero.
test('a muse wake submits while unread and drains at zero', { skip: skipWithoutTmux }, async () => {
  const session = `muse-wake-idle-${process.pid}`
  startPane(session)
  const restore = useMusePane(session)
  unreadScript = [1, 1, 0]
  unreadDefault = 0
  try {
    assert.equal(await deliverChannelNotice(NOTICE, { event_type: 'chat' }), true)
    await __museWakeLoopDrainedForTest()
    assert.equal(receivedCount(session), 1)
    assert.match(capture(session), /MUSE-PANE-RECEIVED:.*muse channel notice/)
  } finally {
    restore()
    killPane(session)
  }
})

// No re-delivery: one notice submitted while unread stays unread is typed
// exactly once. The loop quiets after a confirmed submit even though the
// level never drops — typing the line again here is the terminal-repeat
// defect (one message, N copies in the field).
//
// Count typed copies, not submit markers: the fixture shell reads once, so a
// retype lands in the pane without a second marker. After one submit the
// probe appears exactly twice (tty echo of the typing plus the received
// marker); any retype adds a third occurrence.
test('a submitted muse wake is typed once while unread persists', { skip: skipWithoutTmux }, async () => {
  const session = `muse-wake-noresub-${process.pid}`
  startPane(session)
  const restore = useMusePane(session)
  unreadScript = []
  unreadDefault = 1
  const probe = NOTICE.slice(0, 32)
  const probeCount = () => capture(session).split(probe).length - 1
  try {
    assert.equal(await deliverChannelNotice(NOTICE, { event_type: 'chat' }), true)
    await pollFor(async () => receivedCount(session) === 1, 5000, 'the wake to submit')
    assert.equal(probeCount(), 2)
    // Past the post-success recheck window: fail fast on a retype, pass if
    // the loop left the field alone for the whole window.
    const deadline = Date.now() + 4000
    for (;;) {
      if (probeCount() > 2) assert.fail('wake retyped while unread persisted')
      if (Date.now() >= deadline) break
      await new Promise(r => setTimeout(r, 100))
    }
    assert.equal(probeCount(), 2)
  } finally {
    unreadDefault = 0
    await __museWakeLoopDrainedForTest()
    restore()
    killPane(session)
  }
})

// An explicit request is honored once even at zero unread (the wiretap
// shape), and then the loop goes quiet: drained means drained.
test('a muse wake honors one explicit request at zero unread, then quiets', { skip: skipWithoutTmux }, async () => {
  const session = `muse-wake-wiretap-${process.pid}`
  startPane(session)
  const restore = useMusePane(session)
  unreadScript = []
  unreadDefault = 0
  try {
    assert.equal(await deliverChannelNotice(NOTICE, { event_type: 'chat' }), true)
    await __museWakeLoopDrainedForTest()
    assert.equal(receivedCount(session), 1)
    await new Promise(r => setTimeout(r, 200))
    assert.equal(receivedCount(session), 1)
  } finally {
    restore()
    killPane(session)
  }
})

// Coalescing: two rapid notices produce one transaction carrying the newest
// doorbell. The test holds the pane lock across both requests so no typing
// can start until both have landed in the pending slot.
test('rapid muse notices coalesce into one newest-wins submit', { skip: skipWithoutTmux }, async () => {
  const session = `muse-wake-coal-${process.pid}`
  startPane(session)
  const restore = useMusePane(session)
  unreadScript = [2, 2, 0]
  unreadDefault = 0
  const held = await acquirePaneInputLock(session, { op: 'test-hold' })
  try {
    assert.equal(await deliverChannelNotice('📬 first pointer', { event_type: 'chat' }), true)
    assert.equal(await deliverChannelNotice('📬 second pointer', { event_type: 'chat' }), true)
  } finally {
    held.release()
  }
  try {
    await __museWakeLoopDrainedForTest()
    assert.equal(receivedCount(session), 1)
    assert.match(capture(session), /MUSE-PANE-RECEIVED:.*second pointer/)
  } finally {
    restore()
    killPane(session)
  }
})

// Politeness plus level-trigger in one: a human draft is never touched
// across repeated deferrals, and clearing it lets the waiting wake through.
test('a muse wake holds off a human draft, then submits once cleared', { skip: skipWithoutTmux }, async () => {
  const session = `muse-wake-human-${process.pid}`
  startPane(session)
  const restore = useMusePane(session)
  unreadScript = []
  unreadDefault = 1
  try {
    execFileSync('tmux', ['send-keys', '-t', session, '--', 'hi mom'], { timeout: 5000 })
    execFileSync('sleep', ['0.3'])
    assert.equal(await deliverChannelNotice(NOTICE, { event_type: 'chat' }), true)
    await new Promise(r => setTimeout(r, 600))
    assert.equal(receivedCount(session), 0)
    assert.match(captureStyled(session), /hi mom/)
    // The human clears their own draft; the waiting level wakes the pane.
    execFileSync('tmux', ['send-keys', '-t', session, 'C-u'], { timeout: 5000 })
    await pollFor(async () => receivedCount(session) === 1, 5000, 'the deferred wake to submit')
    unreadDefault = 0
    await __museWakeLoopDrainedForTest()
    assert.equal(receivedCount(session), 1)
  } finally {
    restore()
    killPane(session)
  }
})

// Adoption: a 📬-led line with no park record (another sidecar's park, or a
// park from before records existed) is submitted once still.
test('a muse wake adopts an unrecorded parked pointer', { skip: skipWithoutTmux }, async () => {
  const session = `muse-wake-adopt-${process.pid}`
  startPane(session)
  const restore = useMusePane(session)
  unreadScript = []
  unreadDefault = 1
  try {
    execFileSync('tmux', ['send-keys', '-t', session, '--', '📬 old pointer'], { timeout: 5000 })
    execFileSync('sleep', ['0.3'])
    assert.equal(await deliverChannelNotice(NOTICE, { event_type: 'chat' }), true)
    await pollFor(async () => receivedCount(session) === 1, 5000, 'the parked pointer to submit')
    assert.match(capture(session), /MUSE-PANE-RECEIVED:.*old pointer/)
    unreadDefault = 0
    await __museWakeLoopDrainedForTest()
  } finally {
    restore()
    killPane(session)
  }
})

// Hands off human-appended text: our park record plus extra typing after it
// is theirs now. Killing the pane ends the loop via the pane-gone path.
test('a muse wake leaves human-appended parked text alone', { skip: skipWithoutTmux }, async () => {
  const session = `muse-wake-append-${process.pid}`
  startPane(session)
  const restore = useMusePane(session)
  const { writeParkedWake } = await import('../shared/pane-input-lock.mjs')
  unreadScript = []
  unreadDefault = 1
  try {
    writeParkedWake(session, '📬 pointer')
    execFileSync('tmux', ['send-keys', '-t', session, '--', '📬 pointer call mom'], { timeout: 5000 })
    execFileSync('sleep', ['0.3'])
    assert.equal(await deliverChannelNotice(NOTICE, { event_type: 'chat' }), true)
    await new Promise(r => setTimeout(r, 600))
    assert.equal(receivedCount(session), 0)
    assert.match(captureStyled(session), /call mom/)
  } finally {
    killPane(session)
    await __museWakeLoopDrainedForTest()
    restore()
  }
})

// Ghost-hint reads are pure functions of the region: dim hint text is an
// empty composer, bright or unstyled text is a draft. No tmux needed.
test('ghost-hint classification reads styles, not just text', () => {
  const dim = '\x1b[38;2;103;108;116m'
  const bright = '\x1b[38;2;204;211;219m'
  const reset = '\x1b[0m'
  // Real capture shape: the glyph carries its own style, the hint/draft
  // style follows it (see HEAD's 1.3.0 fixtures).
  assert.equal(museComposerGhost([`❯ ${dim}/tasks shows workflows...${reset}`]), true)
  assert.equal(museSquatterKindStyled([`❯ ${dim}/tasks shows workflows...${reset}`]), 'empty')
  assert.equal(museComposerGhost([`❯ ${bright}hi${reset}`]), false)
  assert.equal(museSquatterKindStyled([`❯ ${bright}hi${reset}`]), 'foreign')
  assert.equal(museSquatterKindStyled(['❯ hi']), 'foreign')
  assert.equal(museSquatterKindStyled(['❯ ']), 'empty')
})

// Codex is NOT changed by this work and keeps its 400ms settle -- measured on
// a live idle codex pane 2026-09-13: text visible at 991ms, Enter accepted at
// both 400ms and 1200ms, so codex queues input rather than dropping it. This
// asserts that the sibling case still delivers, because the muse case sits in
// the same switch and the next edit to it should not be able to break codex
// silently.
test('the codex case still submits into its pane', { skip: skipWithoutTmux }, async () => {
  const session = `codex-notice-test-${process.pid}`
  const previousHarness = process.env.FLEET_HARNESS
  const previousSession = process.env.FLEET_TMUX_SESSION
  startPane(session)
  process.env.FLEET_HARNESS = 'codex'
  process.env.FLEET_TMUX_SESSION = session

  try {
    const delivered = await deliverChannelNotice(NOTICE, { event_type: 'chat' })
    assert.equal(delivered, true)

    const pane = capture(session)
    assert.match(pane, new RegExp(`MUSE-PANE-RECEIVED:.*muse channel notice`))
  } finally {
    if (previousHarness === undefined) delete process.env.FLEET_HARNESS
    else process.env.FLEET_HARNESS = previousHarness
    if (previousSession === undefined) delete process.env.FLEET_TMUX_SESSION
    else process.env.FLEET_TMUX_SESSION = previousSession
    killPane(session)
  }
})
