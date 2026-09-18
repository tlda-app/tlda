import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from 'node:inspector'
import { createProfileWindowRotator } from './profile-window-rotator.mjs'

function connected() {
  const session = new Session()
  session.connect()
  const post = (m, p) => new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))))
  return { session, post }
}

async function enable({ post }, intervalUs = 1000) {
  await post('Profiler.enable')
  await post('Profiler.setSamplingInterval', { interval: intervalUs })
}

// Compile real functions so the isolate holds code to walk. This is the variable
// the defect scaled with, so a test that does not grow it cannot see the defect.
function compile(n) {
  const fns = []
  for (let i = 0; i < n; i++) {
    const f = new Function('x', `let a = x + ${i}; for (let k=0;k<3;k++) a += Math.sqrt(k+${i}); return a;`)
    f(i)
    fns.push(f)
  }
  return fns
}

function burn(fns, ms) {
  const end = Date.now() + ms
  let a = 0
  while (Date.now() < end) for (const f of fns) { a += f(a % 7); if (Date.now() >= end) break }
  return a
}

test('a rotated window is a real profile — nodes, samples and matching deltas', async () => {
  const conn = connected()
  await enable(conn)
  const rotator = createProfileWindowRotator(conn)
  try {
    rotator.open()
    const fns = compile(200)
    burn(fns, 60)
    const { profile, startedAtMs, endedAtMs } = await rotator.rotate()
    assert.ok(profile.nodes.length > 0, 'window had no nodes')
    assert.equal(profile.timeDeltas.length, profile.samples.length, 'deltas do not match samples')
    assert.ok(endedAtMs >= startedAtMs, 'window ended before it started')
  } finally {
    await rotator.close()
    await conn.post('Profiler.disable')
    conn.session.disconnect()
  }
})

test('rotating stays cheap once the isolate holds a lot of compiled code', async () => {
  // THE DEFECT THIS FILE EXISTS FOR. Stopping and restarting the profiler walks
  // every compiled function on the JS thread: measured on this machine at 80,000
  // functions, one stop/start pair cost 349ms + 2958ms. Rotating without letting
  // the profile count reach zero costs under a millisecond.
  //
  // The threshold is deliberately far above the observed cost of the fix and far
  // below the observed cost of the defect, so it is a real gate rather than a
  // timing coin-flip: the old implementation missed it by more than an order of
  // magnitude.
  const conn = connected()
  await enable(conn)
  const rotator = createProfileWindowRotator(conn)
  try {
    rotator.open()
    const fns = compile(20_000)
    burn(fns, 30)
    const worst = []
    for (let i = 0; i < 3; i++) {
      const t0 = process.hrtime.bigint()
      await rotator.rotate()
      worst.push(Number(process.hrtime.bigint() - t0) / 1e6)
    }
    const slowest = Math.max(...worst)
    assert.ok(slowest < 250, `rotation blocked for ${slowest.toFixed(1)}ms; the profiler is being restarted per window`)
  } finally {
    await rotator.close()
    await conn.post('Profiler.disable')
    conn.session.disconnect()
  }
})

test('two rotators in one process do not take each other\'s windows', async () => {
  // Console profile titles name profiles in the isolate and every enabled
  // session hears every finish, so a shared pair of titles has the continuous
  // sampler and the lag sampler ending each other's windows. This process runs
  // both, so that is the live configuration, not a hypothetical one.
  const a = connected()
  const b = connected()
  await enable(a)
  await enable(b)
  const first = createProfileWindowRotator(a)
  const second = createProfileWindowRotator(b)
  try {
    first.open()
    second.open()
    const fns = compile(200)
    burn(fns, 60)
    const [wa, wb] = await Promise.all([first.rotate(), second.rotate()])
    assert.ok(wa.profile.nodes.length > 0, 'first rotator got an empty window')
    assert.ok(wb.profile.nodes.length > 0, 'second rotator got an empty window')
    assert.notEqual(wa.profile, wb.profile, 'both rotators were handed the same profile object')
    // Both must still be open: neither rotator may have ended the other's window.
    assert.equal(first.isOpen(), true)
    assert.equal(second.isOpen(), true)
  } finally {
    await first.close()
    await second.close()
    await a.post('Profiler.disable')
    await b.post('Profiler.disable')
    a.session.disconnect()
    b.session.disconnect()
  }
})
