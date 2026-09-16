import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.FLEET_ID = 'fleet:test-agent'
const CONFIG_DIR_FIXTURE = mkdtempSync(join(tmpdir(), 'agy-notice-bindings-'))
process.env.TLDA_CONFIG_DIR = CONFIG_DIR_FIXTURE
process.env.TLDA_ENV = 'agy-notice-test'
writeFileSync(join(CONFIG_DIR_FIXTURE, 'daemon.yaml'), [
  'environments:',
  '  default: agy-notice-test',
  '  values:',
  '    agy-notice-test:',
  '      database: http://127.0.0.1:1',
  '      store: http://127.0.0.1:1',
  '      licenseKey: ""',
  '',
].join('\n'))

const { deliverChannelNotice } = await import('./fleet-tools.mjs')

// Same assertion shape as the muse suite: the line was SUBMITTED (marker in
// the transcript), not merely visible (which is what a lost Enter looks
// like). agy's composer glyph is `>`; submitted text scrolls above it.
const PANE_MARKER = 'AGY-PANE-RECEIVED:'
const NOTICE = '📬 agy channel notice'

function startPane(name) {
  execFileSync('tmux', [
    'new-session', '-d', '-s', name,
    'sh', '-c', `printf '> '; read line; echo "${PANE_MARKER}$line"; printf '> '; sleep 30`,
  ], { timeout: 5000 })
  execFileSync('sleep', ['0.3'])
}

function killPane(name) {
  try {
    execFileSync('tmux', ['kill-session', '-t', name], { timeout: 5000 })
  } catch {
    // Best-effort cleanup: the pane's `sleep 30` reaps it anyway.
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

async function withEnv(harness, session, fn) {
  const previousHarness = process.env.FLEET_HARNESS
  const previousSession = process.env.FLEET_TMUX_SESSION
  process.env.FLEET_HARNESS = harness
  process.env.FLEET_TMUX_SESSION = session
  try {
    return await fn()
  } finally {
    if (previousHarness === undefined) delete process.env.FLEET_HARNESS
    else process.env.FLEET_HARNESS = previousHarness
    if (previousSession === undefined) delete process.env.FLEET_TMUX_SESSION
    else process.env.FLEET_TMUX_SESSION = previousSession
  }
}

// Before the agy case existed, every notification to an agy agent fell
// through to `default` and threw `Unhandled harness kind: agy`.
test('an agy notification is submitted into the agent pane', { skip: skipWithoutTmux }, async () => {
  const session = `agy-notice-test-${process.pid}`
  startPane(session)
  try {
    await withEnv('agy', session, async () => {
      const delivered = await deliverChannelNotice(NOTICE, { event_type: 'chat' })
      assert.equal(delivered, true)
    })
    assert.match(capture(session), new RegExp(`${PANE_MARKER}.*agy channel notice`))
  } finally {
    killPane(session)
  }
})

// agy's measured behaviour: pasted text digests progressively (~20
// chars/sec on a live pane) and an Enter landing mid-digestion is lost.
// The fixture drips rendered characters and drops Enters until the render
// completes; only the type-wait makes this pass. Drip rate is accelerated
// for test speed — the property under test is progressive render, not 20/s.
const DRIP_PANE = `
process.stdin.setRawMode(true)
let buf = ''
let shown = 0
let renderDone = false
process.stdout.write('> ')
process.stdin.on('data', d => {
  for (const ch of d.toString('utf8')) {
    if (ch === '\\r' || ch === '\\n') {
      if (!renderDone || !buf) continue
      process.stdout.write('\\r\\n${PANE_MARKER}' + buf + '\\r\\n> ')
      buf = ''
      shown = 0
      renderDone = false
    } else {
      buf += ch
    }
  }
})
setInterval(() => {
  if (shown < buf.length) {
    shown = Math.min(buf.length, shown + 12)
    process.stdout.write('\\r> ' + buf.slice(0, shown) + '\\x1b[K')
    if (shown >= buf.length) renderDone = true
  }
}, 150)
setTimeout(() => process.exit(0), 60000)
`

function startDripPane(name) {
  const script = join(mkdtempSync(join(tmpdir(), 'agy-drip-pane-')), 'pane.mjs')
  writeFileSync(script, DRIP_PANE)
  execFileSync('tmux', ['new-session', '-d', '-s', name, 'sh', '-c', `stty -echo; exec ${process.execPath} ${script}`], { timeout: 5000 })
  execFileSync('sleep', ['0.5'])
}

test('a notification reaches a pane that digests typed input progressively', { skip: skipWithoutTmux }, async () => {
  const session = `agy-notice-drip-${process.pid}`
  startDripPane(session)
  try {
    await withEnv('agy', session, async () => {
      const delivered = await deliverChannelNotice(NOTICE, { event_type: 'chat' })
      assert.equal(delivered, true)
    })
    assert.match(capture(session), new RegExp(`${PANE_MARKER}.*agy channel notice`))
  } finally {
    killPane(session)
  }
})

test('a pane that never submits fails loudly instead of reporting delivery', { skip: skipWithoutTmux }, async () => {
  const session = `agy-notice-stuck-${process.pid}`
  execFileSync('tmux', [
    'new-session', '-d', '-s', session,
    'sh', '-c', `printf '> '; sleep 90`,
  ], { timeout: 5000 })
  execFileSync('sleep', ['0.3'])
  try {
    await withEnv('agy', session, async () => {
      await assert.rejects(
        () => deliverChannelNotice(NOTICE, { event_type: 'chat' }),
        /still sitting in the prompt/,
      )
    })
  } finally {
    killPane(session)
  }
})

test('a long notification is refused before anything is typed', { skip: skipWithoutTmux }, async () => {
  const session = `agy-notice-long-${process.pid}`
  startPane(session)
  try {
    await withEnv('agy', session, async () => {
      await assert.rejects(
        () => deliverChannelNotice(`${'x'.repeat(401)}`, { event_type: 'chat' }),
        /refusing to notify/,
      )
    })
    assert.doesNotMatch(capture(session), /x{10}/, 'nothing was typed')
  } finally {
    killPane(session)
  }
})
