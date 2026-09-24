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

const { deliverChannelNotice, museComposerRegion, museComposerText, museSquatterKind } = await import('./fleet-tools.mjs')

// The fixture pane presents muse's prompt glyph, reads one line, echoes it
// behind a marker, then presents a fresh prompt. That shape is what the
// production check reads: text arrives ON the prompt line, and submitting
// moves it OFF into the transcript above.
//
// The assertion is that the line was SUBMITTED, not that its characters are in
// the pane. That distinction is the whole subject -- a lost Enter leaves the
// text visible and unsent, which reads exactly like someone composing, so an
// assertion on the text alone would pass for the very failure this exists to
// prevent. A submitted line also stays on screen as transcript, so a substring
// count over the pane cannot discriminate either.
const PANE_MARKER = 'MUSE-PANE-RECEIVED:'
const NOTICE = '📬 muse channel notice'

function startPane(name) {
  execFileSync('tmux', [
    'new-session', '-d', '-s', name,
    'sh', '-c', `printf '❯ '; read line; echo "${PANE_MARKER}$line"; printf '❯ '; sleep 30`,
  ], { timeout: 5000 })
  // Let the shell reach its `read` before anything is typed at it.
  execFileSync('sleep', ['0.3'])
}

// A pane that behaves the way muse measurably does: typed input is rendered by
// the program after a delay rather than echoed by the tty, and a CR arriving
// before that render is DROPPED. A plain `sh` pane cannot stand in for this --
// the kernel echoes typed characters instantly, so a blind Enter succeeds
// there and the type-wait looks unnecessary. That is not muse.
//
// Raw mode is what removes tty echo; the 1200ms is this fixture's own render
// latency, chosen above the 0.4-0.8s measured on real panes so a blind Enter
// is reliably lost rather than intermittently lost.
const SLOW_RENDER_PANE = `
process.stdin.setRawMode(true)
let buf = ''
let rendered = false
let pending = null
process.stdout.write('❯ ')
process.stdin.on('data', d => {
  for (const ch of d.toString('utf8')) {
    if (ch === '\\r' || ch === '\\n') {
      if (!rendered) continue
      process.stdout.write('\\r\\n${PANE_MARKER}' + buf + '\\r\\n❯ ')
      buf = ''
      rendered = false
      if (pending) { clearTimeout(pending); pending = null }
    } else {
      buf += ch
      if (!rendered && !pending) {
        pending = setTimeout(() => { process.stdout.write(buf); rendered = true; pending = null }, 1200)
      }
    }
  }
})
setTimeout(() => process.exit(0), 30000)
`

function startSlowRenderPane(name) {
  const script = join(mkdtempSync(join(tmpdir(), 'muse-slow-pane-')), 'pane.mjs')
  writeFileSync(script, SLOW_RENDER_PANE)
  // `stty -echo` before exec closes the window between pane start and
  // setRawMode in which the tty echoes typed characters itself. Without it the
  // echo lands on the prompt line instantly, the type-wait is satisfied by the
  // echo rather than by the program's render, and the fixture stops testing
  // anything -- measured while writing this: the wait passed at t+0ms against
  // text the program had not rendered and would not accept an Enter for.
  execFileSync('tmux', ['new-session', '-d', '-s', name, 'sh', '-c', `stty -echo; exec ${process.execPath} ${script}`], { timeout: 5000 })
  execFileSync('sleep', ['0.5'])
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

function tmuxAvailable() {
  try {
    execFileSync('tmux', ['-V'], { timeout: 5000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const skipWithoutTmux = tmuxAvailable() ? false : 'tmux not available'

// `prepareFleetConfig` sets FLEET_HARNESS: 'muse', so harnessKindFromEnv()
// returns 'muse'. Before this case existed, every notification to a muse agent
// fell through to `default` and threw, and the handler answered the server's
// wake with `channel-error` -- so a muse agent only ever saw a message by
// polling its own inbox.
test('a muse notification is submitted into the agent pane', { skip: skipWithoutTmux }, async () => {
  const session = `muse-notice-test-${process.pid}`
  const previousHarness = process.env.FLEET_HARNESS
  const previousSession = process.env.FLEET_TMUX_SESSION
  startPane(session)
  process.env.FLEET_HARNESS = 'muse'
  process.env.FLEET_TMUX_SESSION = session

  try {
    const delivered = await deliverChannelNotice(NOTICE, { event_type: 'chat' })
    assert.equal(delivered, true)

    const pane = capture(session)
    assert.match(pane, new RegExp(`${PANE_MARKER}.*muse channel notice`))
  } finally {
    if (previousHarness === undefined) delete process.env.FLEET_HARNESS
    else process.env.FLEET_HARNESS = previousHarness
    if (previousSession === undefined) delete process.env.FLEET_TMUX_SESSION
    else process.env.FLEET_TMUX_SESSION = previousSession
    killPane(session)
  }
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
// found in a capture could not be distinguished from the text echoing as it
// was typed.
test('an unsubmitted line leaves the marker absent', { skip: skipWithoutTmux }, () => {
  const session = `muse-notice-control-${process.pid}`
  startPane(session)
  try {
    execFileSync('tmux', ['send-keys', '-t', session, '--', NOTICE], { timeout: 5000 })
    execFileSync('sleep', ['1.5'])
    const pane = capture(session)
    assert.match(pane, /muse channel notice/)
    assert.doesNotMatch(pane, new RegExp(PANE_MARKER))
  } finally {
    killPane(session)
  }
})

// This is the test that makes the FIRST wait load-bearing. Against a pane that
// renders typed input late -- muse's actual behaviour -- an Enter sent before
// the render is dropped, and the notification is left sitting in the compose
// line unsent. Waiting for the text to appear before pressing Enter is the
// only thing that makes this pass.
//
// Without it, disabling the type-wait leaves the whole suite green: a plain
// `sh` pane echoes instantly, so a blind Enter works there and the wait tests
// as unnecessary when it is not.
test('a notification reaches a pane that renders typed input late', { skip: skipWithoutTmux }, async () => {
  const session = `muse-notice-slow-${process.pid}`
  const previousHarness = process.env.FLEET_HARNESS
  const previousSession = process.env.FLEET_TMUX_SESSION
  startSlowRenderPane(session)
  process.env.FLEET_HARNESS = 'muse'
  process.env.FLEET_TMUX_SESSION = session

  try {
    const delivered = await deliverChannelNotice(NOTICE, { event_type: 'chat' })
    assert.equal(delivered, true)

    const pane = capture(session)
    assert.match(pane, new RegExp(`${PANE_MARKER}.*muse channel notice`))
  } finally {
    if (previousHarness === undefined) delete process.env.FLEET_HARNESS
    else process.env.FLEET_HARNESS = previousHarness
    if (previousSession === undefined) delete process.env.FLEET_TMUX_SESSION
    else process.env.FLEET_TMUX_SESSION = previousSession
    killPane(session)
  }
})

// A pane that drops the FIRST Enter but accepts the next is today's live
// failure: text typed fine onto an idle prompt, one Enter lost, notice dead
// in the compose line while the agent idles. The submitter must press Enter
// again while its own text is still there instead of failing after one shot.
const DROP_FIRST_ENTER_PANE = `
process.stdin.setRawMode(true)
let buf = ''
let rendered = false
let pending = null
let enters = 0
process.stdout.write('❯ ')
process.stdin.on('data', d => {
  for (const ch of d.toString('utf8')) {
    if (ch === '\\r' || ch === '\\n') {
      enters++
      if (!rendered || enters < 2) continue
      process.stdout.write('\\r\\n${PANE_MARKER}' + buf + '\\r\\n❯ ')
      buf = ''
      rendered = false
    } else {
      buf += ch
      if (!rendered && !pending) {
        pending = setTimeout(() => { process.stdout.write(buf); rendered = true; pending = null }, 200)
      }
    }
  }
})
setTimeout(() => process.exit(0), 30000)
`

function startDropFirstEnterPane(name) {
  const script = join(mkdtempSync(join(tmpdir(), 'muse-drop-enter-pane-')), 'pane.mjs')
  writeFileSync(script, DROP_FIRST_ENTER_PANE)
  execFileSync('tmux', ['new-session', '-d', '-s', name, 'sh', '-c', `stty -echo; exec ${process.execPath} ${script}`], { timeout: 5000 })
  execFileSync('sleep', ['0.5'])
}

test('a dropped first Enter is retried, not reported failed', { skip: skipWithoutTmux }, async () => {
  const session = `muse-notice-retry-${process.pid}`
  startDropFirstEnterPane(session)
  const previousHarness = process.env.FLEET_HARNESS
  const previousSession = process.env.FLEET_TMUX_SESSION
  process.env.FLEET_HARNESS = 'muse'
  process.env.FLEET_TMUX_SESSION = session

  try {
    const delivered = await deliverChannelNotice(NOTICE, { event_type: 'chat' })
    assert.equal(delivered, true)

    const pane = capture(session)
    assert.match(pane, new RegExp(`${PANE_MARKER}.*muse channel notice`))
  } finally {
    if (previousHarness === undefined) delete process.env.FLEET_HARNESS
    else process.env.FLEET_HARNESS = previousHarness
    if (previousSession === undefined) delete process.env.FLEET_TMUX_SESSION
    else process.env.FLEET_TMUX_SESSION = previousSession
    killPane(session)
  }
})

// A pane that never accepts the Enter must FAIL, loudly, rather than be
// reported delivered. `cat` holds the prompt glyph but consumes the line
// without ever clearing it from the compose line, which is what a lost Enter
// looks like from outside -- so the submit wait times out and throws.
//
// This is the case the old settle could not detect at all: it sent Enter,
// returned true, and a notification nobody received was reported delivered.
test('a pane that never submits fails loudly instead of reporting delivery', { skip: skipWithoutTmux }, async () => {
  const session = `muse-notice-stuck-${process.pid}`
  const previousHarness = process.env.FLEET_HARNESS
  const previousSession = process.env.FLEET_TMUX_SESSION
  // No `read`: the glyph is printed and the shell then sleeps, so typed text
  // lands on the prompt line and stays there whatever we send after it.
  execFileSync('tmux', [
    'new-session', '-d', '-s', session,
    'sh', '-c', `printf '❯ '; sleep 30`,
  ], { timeout: 5000 })
  execFileSync('sleep', ['0.3'])
  process.env.FLEET_HARNESS = 'muse'
  process.env.FLEET_TMUX_SESSION = session

  try {
    await assert.rejects(
      () => deliverChannelNotice(NOTICE, { event_type: 'chat' }),
      /still sitting in the prompt/,
    )
  } finally {
    if (previousHarness === undefined) delete process.env.FLEET_HARNESS
    else process.env.FLEET_HARNESS = previousHarness
    if (previousSession === undefined) delete process.env.FLEET_TMUX_SESSION
    else process.env.FLEET_TMUX_SESSION = previousSession
    killPane(session)
  }
})

// A stale notice squatting in the composer must be REPLACED, not piled onto.
// Observed live 2026-09-24: two notices fused into one 11k-char franken-turn
// on a production pane, submitted and reported delivered. The fixture boots
// with a 📬-led squatter rendered; C-u clears it; the fresh notice submits
// alone. The marker line must carry the fresh notice WITHOUT the squatter.
const SQUATTER_PANE = `
process.stdin.setRawMode(true)
let buf = '📬 stale squatter pointer — call inbox()'
process.stdout.write('❯ ' + buf)
process.stdin.on('data', d => {
  for (const ch of d.toString('utf8')) {
    if (ch === '\\x15') {
      buf = ''
      process.stdout.write('\\r❯ \\x1b[K')
    } else if (ch === '\\r' || ch === '\\n') {
      process.stdout.write('\\r\\n${PANE_MARKER}' + buf + '\\r\\n❯ ')
      buf = ''
    } else {
      buf += ch
      process.stdout.write(ch)
    }
  }
})
setTimeout(() => process.exit(0), 30000)
`

function startSquatterPane(name) {
  const script = join(mkdtempSync(join(tmpdir(), 'muse-squatter-pane-')), 'pane.mjs')
  writeFileSync(script, SQUATTER_PANE)
  execFileSync('tmux', ['new-session', '-d', '-s', name, 'sh', '-c', `stty -echo; exec ${process.execPath} ${script}`], { timeout: 5000 })
  execFileSync('sleep', ['0.5'])
}

test('a stale notice in the composer is replaced, not piled onto', { skip: skipWithoutTmux }, async () => {
  const session = `muse-notice-squatter-${process.pid}`
  const previousHarness = process.env.FLEET_HARNESS
  const previousSession = process.env.FLEET_TMUX_SESSION
  startSquatterPane(session)
  process.env.FLEET_HARNESS = 'muse'
  process.env.FLEET_TMUX_SESSION = session

  try {
    const delivered = await deliverChannelNotice(NOTICE, { event_type: 'chat' })
    assert.equal(delivered, true)

    const pane = capture(session)
    const markerLine = pane.split('\n').find(l => l.includes(PANE_MARKER))
    assert.ok(markerLine, 'expected a submitted marker line')
    assert.match(markerLine, /muse channel notice/)
    assert.doesNotMatch(markerLine, /stale squatter/)
  } finally {
    if (previousHarness === undefined) delete process.env.FLEET_HARNESS
    else process.env.FLEET_HARNESS = previousHarness
    if (previousSession === undefined) delete process.env.FLEET_TMUX_SESSION
    else process.env.FLEET_TMUX_SESSION = previousSession
    killPane(session)
  }
})

// The agent's own unfinished thought is not ours to touch. Clearing it would
// destroy work and appending to it would submit a franken-turn, so delivery
// declines (false, not a throw) and the pane is left exactly as found.
test('foreign composer text declines delivery without touching the pane', { skip: skipWithoutTmux }, async () => {
  const session = `muse-notice-foreign-${process.pid}`
  const previousHarness = process.env.FLEET_HARNESS
  const previousSession = process.env.FLEET_TMUX_SESSION
  execFileSync('tmux', [
    'new-session', '-d', '-s', session,
    'sh', '-c', `printf '❯ agent draft here'; sleep 30`,
  ], { timeout: 5000 })
  execFileSync('sleep', ['0.3'])
  process.env.FLEET_HARNESS = 'muse'
  process.env.FLEET_TMUX_SESSION = session

  try {
    const delivered = await deliverChannelNotice(NOTICE, { event_type: 'chat' })
    assert.equal(delivered, false)

    const pane = capture(session)
    assert.match(pane, /agent draft here/)
    assert.doesNotMatch(pane, /muse channel notice/)
  } finally {
    if (previousHarness === undefined) delete process.env.FLEET_HARNESS
    else process.env.FLEET_HARNESS = previousHarness
    if (previousSession === undefined) delete process.env.FLEET_TMUX_SESSION
    else process.env.FLEET_TMUX_SESSION = previousSession
    killPane(session)
  }
})

// No composer at all (a mid-turn render with no prompt line) declines rather
// than typing blind into the live turn.
test('a pane with no composer declines without typing', { skip: skipWithoutTmux }, async () => {
  const session = `muse-notice-nocomposer-${process.pid}`
  const previousHarness = process.env.FLEET_HARNESS
  const previousSession = process.env.FLEET_TMUX_SESSION
  execFileSync('tmux', [
    'new-session', '-d', '-s', session,
    'sh', '-c', `printf '◇ Thinking (esc to interrupt)'; sleep 30`,
  ], { timeout: 5000 })
  execFileSync('sleep', ['0.3'])
  process.env.FLEET_HARNESS = 'muse'
  process.env.FLEET_TMUX_SESSION = session

  try {
    const delivered = await deliverChannelNotice(NOTICE, { event_type: 'chat' })
    assert.equal(delivered, false)

    const pane = capture(session)
    assert.doesNotMatch(pane, /muse channel notice/)
  } finally {
    if (previousHarness === undefined) delete process.env.FLEET_HARNESS
    else process.env.FLEET_HARNESS = previousHarness
    if (previousSession === undefined) delete process.env.FLEET_TMUX_SESSION
    else process.env.FLEET_TMUX_SESSION = previousSession
    killPane(session)
  }
})

// A pane that drops every Enter gets its parked text WITHDRAWN before the
// loud failure: the throw says what happened, and the composer is left clean
// instead of holding a phantom draft. Raw fixture so C-u behaviour is exact:
// Enter ignored, C-u clears and re-renders an empty prompt.
const DROP_ENTER_HONOR_CU_PANE = `
process.stdin.setRawMode(true)
let buf = ''
process.stdout.write('❯ ')
process.stdin.on('data', d => {
  for (const ch of d.toString('utf8')) {
    if (ch === '\\x15') {
      buf = ''
      process.stdout.write('\\r❯ \\x1b[K')
    } else if (ch === '\\r' || ch === '\\n') {
      continue
    } else {
      buf += ch
      process.stdout.write(ch)
    }
  }
})
setTimeout(() => process.exit(0), 60000)
`

function startDropEnterHonorCuPane(name) {
  const script = join(mkdtempSync(join(tmpdir(), 'muse-withdraw-pane-')), 'pane.mjs')
  writeFileSync(script, DROP_ENTER_HONOR_CU_PANE)
  execFileSync('tmux', ['new-session', '-d', '-s', name, 'sh', '-c', `stty -echo; exec ${process.execPath} ${script}`], { timeout: 5000 })
  execFileSync('sleep', ['0.5'])
}

test('a failed submit withdraws our text and fails loudly', { skip: skipWithoutTmux }, async () => {
  const session = `muse-notice-withdraw-${process.pid}`
  const previousHarness = process.env.FLEET_HARNESS
  const previousSession = process.env.FLEET_TMUX_SESSION
  startDropEnterHonorCuPane(session)
  process.env.FLEET_HARNESS = 'muse'
  process.env.FLEET_TMUX_SESSION = session

  try {
    await assert.rejects(
      () => deliverChannelNotice(NOTICE, { event_type: 'chat' }),
      /withdrew our text with C-u/,
    )
    const pane = capture(session)
    assert.doesNotMatch(pane, /muse channel notice/)
  } finally {
    if (previousHarness === undefined) delete process.env.FLEET_HARNESS
    else process.env.FLEET_HARNESS = previousHarness
    if (previousSession === undefined) delete process.env.FLEET_TMUX_SESSION
    else process.env.FLEET_TMUX_SESSION = previousSession
    killPane(session)
  }
})

// The control: a pane that honours neither Enter nor C-u must say the text
// may still be parked, not claim a withdraw it did not verify.
const DROP_ENTER_DROP_CU_PANE = `
process.stdin.setRawMode(true)
let buf = ''
process.stdout.write('❯ ')
process.stdin.on('data', d => {
  for (const ch of d.toString('utf8')) {
    if (ch === '\\x15' || ch === '\\r' || ch === '\\n') continue
    buf += ch
    process.stdout.write(ch)
  }
})
setTimeout(() => process.exit(0), 60000)
`

function startDropEnterDropCuPane(name) {
  const script = join(mkdtempSync(join(tmpdir(), 'muse-parked-pane-')), 'pane.mjs')
  writeFileSync(script, DROP_ENTER_DROP_CU_PANE)
  execFileSync('tmux', ['new-session', '-d', '-s', name, 'sh', '-c', `stty -echo; exec ${process.execPath} ${script}`], { timeout: 5000 })
  execFileSync('sleep', ['0.5'])
}

test('a failed withdraw says the text may still be parked', { skip: skipWithoutTmux }, async () => {
  const session = `muse-notice-parked-${process.pid}`
  const previousHarness = process.env.FLEET_HARNESS
  const previousSession = process.env.FLEET_TMUX_SESSION
  startDropEnterDropCuPane(session)
  process.env.FLEET_HARNESS = 'muse'
  process.env.FLEET_TMUX_SESSION = session

  try {
    await assert.rejects(
      () => deliverChannelNotice(NOTICE, { event_type: 'chat' }),
      /withdraw FAILED.*still be parked/,
    )
    const pane = capture(session)
    assert.match(pane, /muse channel notice/)
  } finally {
    if (previousHarness === undefined) delete process.env.FLEET_HARNESS
    else process.env.FLEET_HARNESS = previousHarness
    if (previousSession === undefined) delete process.env.FLEET_TMUX_SESSION
    else process.env.FLEET_TMUX_SESSION = previousSession
    killPane(session)
  }
})

// Pure unit coverage for the region reader, no tmux: the virgin render keeps
// unsubmitted text BELOW the glyph line (measured live 2026-09-24), the
// post-turn render keeps it ON the line, and the separator rule bounds the
// region so footer text can never satisfy a probe.
test('muse composer region covers both live renders', () => {
  const virgin = [
    '── Voice input (⌥ + v to start) ──',
    '❯',
    '  📬 live probe notice',
    '────────────────────────────────────────',
    '  muse-spark-1.3-contributor · high · ~/work/tlda · YOLO',
  ].join('\n')
  const virginRegion = museComposerRegion(virgin)
  assert.deepEqual(virginRegion, ['❯', '  📬 live probe notice'])
  assert.equal(museSquatterKind(museComposerText(virginRegion)), 'stale-notice')

  const postTurn = [
    '◆ TURNONE-DONE',
    '── Voice input (⌥ + v to start) ──',
    '❯ POSTTURN-PROBE-xyz',
    '────────────────────────────────────────',
    '  muse-spark-1.3-contributor · high · ~/work/tlda · YOLO',
  ].join('\n')
  const postTurnRegion = museComposerRegion(postTurn)
  assert.deepEqual(postTurnRegion, ['❯ POSTTURN-PROBE-xyz'])
  assert.equal(museSquatterKind(museComposerText(postTurnRegion)), 'foreign')

  const idle = ['❯', '', '────────────────────────────────────────'].join('\n')
  assert.equal(museSquatterKind(museComposerText(museComposerRegion(idle))), 'empty')

  assert.equal(museComposerRegion('◇ Thinking (esc to interrupt)'), null)
})
