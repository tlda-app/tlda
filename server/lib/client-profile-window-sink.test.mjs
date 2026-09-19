import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClientProfileWindowHandler, clientProfileDirFor } from './client-profile-window-sink.mjs'

const silent = { log() {} }

function fakeRes() {
  const res = { statusCode: 200, body: null }
  res.status = code => { res.statusCode = code; return res }
  res.json = body => { res.body = body; return res }
  return res
}

// A raw self-profiling trace naming a frame nobody else would emit, so "did the
// burning function survive conversion to the file on disk" is answered by
// finding this exact string rather than by trusting that a file appeared.
function windowCarrying(functionName, at = '2026-09-19T02:00:00.000Z') {
  return {
    at,
    tab: 'tabalpha',
    trace: {
      resources: ['https://example.test/app.js'],
      frames: [{ name: functionName, resourceId: 0, line: 12, column: 3 }],
      stacks: [{ frameId: 0 }],
      samples: [{ timestamp: 0, stackId: 0 }, { timestamp: 10, stackId: 0 }],
    },
  }
}

// What a busy moment produces: many distinct frames, so the window is large.
function busyWindow(at) {
  return {
    at,
    tab: 'tabalpha',
    trace: {
      resources: ['https://example.test/app.js'],
      frames: Array.from({ length: 200 }, (_, i) => ({ name: `busyFrame${i}`, resourceId: 0, line: i + 1, column: 1 })),
      stacks: Array.from({ length: 200 }, (_, i) => ({ frameId: i })),
      samples: Array.from({ length: 200 }, (_, i) => ({ timestamp: i * 10, stackId: i })),
    },
  }
}

function files(dir) {
  try {
    return readdirSync(dir).filter(f => f.endsWith('.cpuprofile')).sort()
  } catch {
    return []
  }
}

function totalBytes(dir) {
  return files(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0)
}

test('the burning function survives conversion to the file on disk', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'clientprof-'))
  try {
    const handler = createClientProfileWindowHandler({ baseDir, log: silent })
    const res = fakeRes()
    await handler({ body: windowCarrying('theFrameUnderTest') }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body.ok, true)

    const dir = clientProfileDirFor(baseDir)
    const written = files(dir)
    assert.equal(written.length, 1, `expected one profile, got ${written.length}`)

    const profile = JSON.parse(readFileSync(join(dir, written[0]), 'utf8'))
    const named = profile.nodes.map(n => n.callFrame.functionName)
    assert.ok(named.includes('theFrameUnderTest'), `written profile named ${named.join(',')}`)
    assert.equal(profile.samples.length, profile.timeDeltas.length)
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})

test('quiet windows are kept, and the budget drops the oldest first', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'clientprof-'))
  try {
    const handler = createClientProfileWindowHandler({ baseDir, maxBytes: 1200, log: silent })
    for (let i = 0; i < 8; i++) {
      // Not one of these is interesting, and that is the point: what is retained
      // must not depend on whether anything happened in the window.
      await handler({ body: windowCarrying('(root)', `2026-09-19T02:0${i}:00.000Z`) }, fakeRes())
    }

    const dir = clientProfileDirFor(baseDir)
    const written = files(dir)
    assert.ok(written.length > 0, 'the budget dropped everything')
    assert.ok(written.length < 8, `the budget bounded nothing: kept all ${written.length}`)
    assert.ok(totalBytes(dir) <= 1200, `retained ${totalBytes(dir)} bytes over the 1200 budget`)
    // Names carry each window's own timestamp and sort oldest first, so the
    // survivors must be the NEWEST windows rather than an arbitrary subset.
    assert.ok(written[written.length - 1].includes('02-07-00'), `newest survivor is ${written[written.length - 1]}`)
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})

test('one busy window costs more of the retained span than a quiet one', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'clientprof-'))
  try {
    // This is what a byte budget buys over a file count: a window runs from a
    // few hundred bytes to a few hundred KB, so counting files would bound the
    // disk at whatever the busiest windows happened to weigh.
    //
    // The budget is measured rather than guessed — a guessed one either evicts
    // nothing or evicts everything, and both pass an "it changed" assertion
    // while testing nothing.
    const sizing = mkdtempSync(join(tmpdir(), 'clientprof-size-'))
    const sizer = createClientProfileWindowHandler({ baseDir: sizing, log: silent })
    await sizer({ body: windowCarrying('quiet') }, fakeRes())
    const quietBytes = totalBytes(clientProfileDirFor(sizing))
    rmSync(sizing, { recursive: true, force: true })

    const sizing2 = mkdtempSync(join(tmpdir(), 'clientprof-size-'))
    const sizer2 = createClientProfileWindowHandler({ baseDir: sizing2, log: silent })
    await sizer2({ body: busyWindow('2026-09-19T02:09:00.000Z') }, fakeRes())
    const busyBytes = totalBytes(clientProfileDirFor(sizing2))
    rmSync(sizing2, { recursive: true, force: true })
    assert.ok(busyBytes > quietBytes * 4, `busy window ${busyBytes} is not meaningfully bigger than quiet ${quietBytes}`)

    // Room for the busy window plus two quiet ones, so arrival of the busy one
    // must evict some of the six quiet ones but cannot evict all of them.
    const maxBytes = busyBytes + quietBytes * 2
    const handler = createClientProfileWindowHandler({ baseDir, maxBytes, log: silent })
    for (let i = 0; i < 6; i++) {
      await handler({ body: windowCarrying('quiet', `2026-09-19T02:0${i}:00.000Z`) }, fakeRes())
    }
    const dir = clientProfileDirFor(baseDir)
    const beforeBusy = files(dir).length
    assert.equal(beforeBusy, 6, `six quiet windows should fit the budget, kept ${beforeBusy}`)

    await handler({ body: busyWindow('2026-09-19T02:09:00.000Z') }, fakeRes())

    const after = files(dir)
    assert.ok(totalBytes(dir) <= maxBytes, `retained ${totalBytes(dir)} bytes over the ${maxBytes} budget`)
    assert.ok(after.length < beforeBusy, `the busy window evicted nothing: ${beforeBusy} then ${after.length}`)
    assert.ok(after[after.length - 1].includes('02-09-00'), 'the newest window was not the one kept')
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})

test('a window bigger than the whole budget is still kept', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'clientprof-'))
  try {
    // Otherwise the trim that runs after writing a window deletes that same
    // window, so the busier the session the less it retains — ending at nothing
    // exactly when there is most to look at.
    const handler = createClientProfileWindowHandler({ baseDir, maxBytes: 10, log: silent })
    await handler({ body: busyWindow('2026-09-19T02:09:00.000Z') }, fakeRes())

    const kept = files(clientProfileDirFor(baseDir))
    assert.equal(kept.length, 1, 'the window deleted itself')
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})

test('two tabs rolling at the same instant both survive', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'clientprof-'))
  try {
    const handler = createClientProfileWindowHandler({ baseDir, log: silent })
    const at = '2026-09-19T02:00:00.000Z'
    await handler({ body: { ...windowCarrying('fromTabA', at), tab: 'tabalpha' } }, fakeRes())
    await handler({ body: { ...windowCarrying('fromTabB', at), tab: 'tabbravo' } }, fakeRes())

    assert.equal(files(clientProfileDirFor(baseDir)).length, 2, 'one tab overwrote the other')
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})

test('a body with no trace is refused rather than written', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'clientprof-'))
  try {
    const handler = createClientProfileWindowHandler({ baseDir, log: silent })
    const res = fakeRes()
    await handler({ body: { at: '2026-09-19T02:00:00.000Z' } }, res)

    assert.equal(res.statusCode, 400)
    assert.equal(res.body.ok, false)
    assert.equal(files(clientProfileDirFor(baseDir)).length, 0)
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})
