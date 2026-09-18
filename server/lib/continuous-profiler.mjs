// Always-on sampling profiler for a Node process.
//
// Samples continuously in rolling windows and writes every window to disk as a
// `.cpuprofile` file. Nothing is filtered, ranked or summarized: V8's
// `Profiler.stop()` already returns the `.cpuprofile` shape, so the profile is
// written through unchanged and speedscope, profview and Chrome DevTools open it
// directly.
//
// Every window is kept, oldest deleted first, bounded by file count. A window is
// not required to be interesting to survive — the question this answers is
// "where did the time go over the last N minutes", which needs the quiet windows
// too.
//
// V8's CPU profiler samples on its own thread, not the JS thread, so frames from
// inside a stall are recorded as they happen and only the disk write waits for
// the loop.
//
// Distinct from `lag-profiler.mjs`, which keeps a slice around an event-loop
// stall and discards the rest. That one is supplemental; this one is the profile.

import { Session } from 'node:inspector'
import { mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const FILE_PREFIX = 'profile-'
const FILE_SUFFIX = '.cpuprofile'

/**
 * @param {object} options
 * @param {string} options.dir              where `.cpuprofile` files are written
 * @param {number} [options.windowMs]       length of one retained window
 * @param {number} [options.samplingIntervalUs]
 * @param {number} [options.maxFiles]       how many windows stay on disk
 * @param {object} [options.log]
 * @param {() => number} [options.now]
 */
export function createContinuousProfiler({
  dir,
  windowMs = Number(process.env.TLDA_PROFILER_WINDOW_MS || 10_000),
  samplingIntervalUs = Number(process.env.TLDA_PROFILER_INTERVAL_US || 1000),
  maxFiles = Number(process.env.TLDA_PROFILER_MAX_FILES || 60),
  log = console,
  now = () => Date.now(),
} = {}) {
  if (!dir) throw new Error('continuous profiler requires a dump directory')

  const session = new Session()
  let running = false
  let windowTimer = null
  let cutting = false
  const stats = { windows: 0, written: 0, failures: 0, lastWriteAt: null, lastError: null }

  const post = (method, params) => new Promise((resolve, reject) => {
    session.post(method, params, (err, result) => (err ? reject(err) : resolve(result)))
  })

  // Oldest first, so trimming is a slice off the front. The timestamp in the
  // name sorts lexicographically because it is ISO with `:` and `.` replaced.
  function retainedFiles() {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(f => f.startsWith(FILE_PREFIX) && f.endsWith(FILE_SUFFIX))
      .sort()
  }

  function trim() {
    const files = retainedFiles()
    if (files.length <= maxFiles) return
    for (const f of files.slice(0, files.length - maxFiles)) {
      try { rmSync(join(dir, f)) } catch { /* a file already gone is the desired state */ }
    }
  }

  async function cutWindow() {
    const { profile } = await post('Profiler.stop')
    // Restart before writing, so coverage is continuous across the disk write.
    if (running) await post('Profiler.start')
    stats.windows += 1

    const at = new Date(now()).toISOString().replace(/[:.]/g, '-')
    const file = join(dir, `${FILE_PREFIX}${at}${FILE_SUFFIX}`)
    try {
      // Written through unchanged: this object IS the `.cpuprofile` format.
      await writeFile(file, JSON.stringify(profile))
      stats.written += 1
      stats.lastWriteAt = at
      trim()
    } catch (e) {
      // A failed write must be visible in the snapshot. A profiler believed to
      // be recording and silently not is worse than one that is off.
      stats.failures += 1
      stats.lastError = e?.message || String(e)
      log.warn?.(`[profiler] failed to write ${file}: ${stats.lastError}`)
    }
  }

  async function rollWindow() {
    if (cutting || !running) return
    cutting = true
    try {
      await cutWindow()
    } catch (e) {
      stats.failures += 1
      stats.lastError = e?.message || String(e)
      log.warn?.(`[profiler] window roll failed: ${stats.lastError}`)
    } finally {
      cutting = false
    }
  }

  async function start() {
    if (running) throw new Error('continuous profiler already running')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    session.connect()
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: samplingIntervalUs })
    await post('Profiler.start')
    running = true

    windowTimer = setInterval(() => { void rollWindow() }, windowMs)
    windowTimer.unref?.()

    log.warn?.(`[profiler] sampling every ${samplingIntervalUs}us, writing ${windowMs}ms windows to ${dir}, keeping ${maxFiles}`)
  }

  async function stop() {
    if (!running) throw new Error('continuous profiler is not running')
    running = false
    clearInterval(windowTimer)
    await post('Profiler.stop')
    await post('Profiler.disable')
    session.disconnect()
  }

  return {
    start,
    stop,
    // Close the current window and write it now, instead of waiting for the
    // interval. This is how "give me the profile for what just happened" is
    // answered without stopping the profiler.
    cut: rollWindow,
    snapshot: () => ({ ...stats, running, retainedFiles: retainedFiles().length, dir }),
  }
}
