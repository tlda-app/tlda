import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContinuousProfiler } from './continuous-profiler.mjs'

const wait = ms => new Promise(r => setTimeout(r, ms))

// A named function, so "did the profiler capture anything real" is answered by
// looking for this exact string rather than by trusting a sample count.
function theControlFunctionUnderTest(ms) {
  const end = Date.now() + ms
  let x = 0
  while (Date.now() < end) x += Math.sqrt(x + 1)
  return x
}

function profileFiles(dir) {
  return readdirSync(dir).filter(f => f.endsWith('.cpuprofile')).sort()
}

test('a window is written as a .cpuprofile naming the function that burned the CPU', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'contprof-'))
  const profiler = createContinuousProfiler({ dir, windowMs: 400, log: { warn() {} } })
  await profiler.start()
  try {
    theControlFunctionUnderTest(500)
    await profiler.cut()

    const files = profileFiles(dir)
    assert.ok(files.length >= 1, `expected at least one profile, got ${files.length}`)

    const found = files.some(f => {
      const profile = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      return profile.nodes.some(n => n.callFrame.functionName === 'theControlFunctionUnderTest')
    })
    assert.equal(found, true, 'no written profile named the burning function')
  } finally {
    await profiler.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('what is written is the .cpuprofile shape, unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'contprof-'))
  const profiler = createContinuousProfiler({ dir, windowMs: 300, log: { warn() {} } })
  await profiler.start()
  try {
    theControlFunctionUnderTest(200)
    await profiler.cut()
    const [first] = profileFiles(dir)
    const profile = JSON.parse(readFileSync(join(dir, first), 'utf8'))
    // The four keys every .cpuprofile reader requires.
    for (const key of ['nodes', 'startTime', 'endTime', 'samples', 'timeDeltas']) {
      assert.ok(key in profile, `missing ${key}`)
    }
    assert.equal(profile.samples.length, profile.timeDeltas.length)
    const ids = new Set(profile.nodes.map(n => n.id))
    for (const s of profile.samples) assert.equal(ids.has(s), true)
  } finally {
    await profiler.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('quiet windows are retained too, not only the busy one', async () => {
  // The gate this design exists to avoid: keeping only interesting windows
  // leaves nothing to compare an interesting one against.
  const dir = mkdtempSync(join(tmpdir(), 'contprof-'))
  const profiler = createContinuousProfiler({ dir, windowMs: 250, log: { warn() {} } })
  await profiler.start()
  try {
    // Burn once, then stay idle across several further windows.
    theControlFunctionUnderTest(120)
    await profiler.cut()
    // Three further windows in which nothing happens at all.
    for (let i = 0; i < 3; i++) { await wait(20); await profiler.cut() }
    assert.equal(profileFiles(dir).length, 4, 'idle windows were not retained')
  } finally {
    await profiler.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('retention is bounded — the oldest windows are deleted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'contprof-'))
  const profiler = createContinuousProfiler({ dir, windowMs: 200, maxFiles: 3, log: { warn() {} } })
  await profiler.start()
  try {
    for (let i = 0; i < 6; i++) await profiler.cut()
    const files = profileFiles(dir)
    assert.ok(files.length <= 3, `retention unbounded: ${files.length} files`)
    assert.ok(profiler.snapshot().windows > 3, 'test did not actually roll past the cap')
  } finally {
    await profiler.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the snapshot reports running state and write failures rather than staying silent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'contprof-'))
  const profiler = createContinuousProfiler({ dir, windowMs: 200, log: { warn() {} } })
  await profiler.start()
  try {
    await profiler.cut()
    const snap = profiler.snapshot()
    assert.equal(snap.running, true)
    assert.equal(snap.failures, 0)
    assert.equal(snap.lastError, null)
    assert.ok(snap.written >= 1)
    assert.equal(snap.dir, dir)
  } finally {
    await profiler.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
