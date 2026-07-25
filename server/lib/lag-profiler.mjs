// Always-on sampling profiler with a lag-triggered dump.
//
// Why this exists: when the server goes deaf, nobody is attached to see why.
// The instrumentation we had could not see it either — `[slowquery]` thresholds
// each query at 25ms, so a handler doing 190 x 4ms logs nothing, and synchronous
// `.run()` writes on the main connection were never wrapped at all. A sampler
// does not care how the time is divided; it sees whatever the thread is actually
// doing, including inside a native synchronous write.
//
// Why sampling works while the loop is blocked: V8's CPU profiler does NOT run
// on the JS thread. It runs a dedicated sampler thread that interrupts the
// isolate and walks its stack. So frames from inside a 300ms stall are recorded
// AS THEY HAPPEN and sit in V8's buffer; only the disk write waits for the loop
// to come back. That is what makes a lag-triggered dump possible at all — the
// interesting frames are already captured by the time we notice the stall.
//
// Shape: one continuous profile, chopped into short rolling windows so memory
// stays bounded. Two windows are retained, so a stall that lands near a window
// boundary is still fully covered. On a stall we cut the current window, slice
// the samples to the stall interval, and write a ranked self-time report.

import { Session } from 'node:inspector'
import { mkdirSync, existsSync } from 'node:fs'
import { writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

// 1ms sampling: V8's default and the standard low-overhead setting. The one-off
// 200us profile taken against live cost ~2% CPU; 1ms is a fifth of that.
const SAMPLING_INTERVAL_US = Number(process.env.TLDA_LAG_PROFILER_INTERVAL_US || 1000)
// Rolling window length. Shorter = less memory and a tighter slice; long enough
// that the stop/start cycle is not itself frequent work.
const WINDOW_MS = Number(process.env.TLDA_LAG_PROFILER_WINDOW_MS || 10_000)
// A stall worth a dump. The observed deafness is seconds long; 250ms is well
// above normal jitter and well below the symptom.
const STALL_MS = Number(process.env.TLDA_LAG_PROFILER_STALL_MS || 250)
// How often we check for a stall. This tick's own overrun IS the measurement.
const TICK_MS = Number(process.env.TLDA_LAG_PROFILER_TICK_MS || 100)
// A sustained stall would otherwise write a dump every tick. Cap the rate so the
// profiler cannot become the thing that fills the disk.
const MIN_DUMP_GAP_MS = Number(process.env.TLDA_LAG_PROFILER_MIN_GAP_MS || 60_000)
const MAX_FRAMES_IN_REPORT = 40

function frameLabel(callFrame) {
  const name = callFrame.functionName || '(anonymous)'
  const url = (callFrame.url || '').replace(/^file:\/\//, '')
  return `${name} @ ${url}:${callFrame.lineNumber + 1}`
}

// Rank functions by self time inside [fromUs, toUs] of this profile, and record
// the deepest stack for the heaviest one — the stall's actual call path.
function summarizeProfile(profile, fromUs, toUs) {
  const byId = new Map(profile.nodes.map(n => [n.id, n]))
  const parent = new Map()
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id)

  const selfUs = new Map()
  let cursorUs = profile.startTime
  let sampledUs = 0
  for (let i = 0; i < profile.samples.length; i++) {
    cursorUs += profile.timeDeltas[i] || 0
    if (cursorUs < fromUs) continue
    if (cursorUs > toUs) break
    const id = profile.samples[i]
    const dt = profile.timeDeltas[i] || 0
    selfUs.set(id, (selfUs.get(id) || 0) + dt)
    sampledUs += dt
  }

  const byLabel = new Map()
  for (const [id, us] of selfUs) {
    const node = byId.get(id)
    if (!node) continue
    const label = frameLabel(node.callFrame)
    byLabel.set(label, (byLabel.get(label) || 0) + us)
  }
  const ranked = [...byLabel]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FRAMES_IN_REPORT)
    .map(([label, us]) => ({ label, ms: +(us / 1000).toFixed(1) }))

  const heaviestId = [...selfUs].sort((a, b) => b[1] - a[1])[0]?.[0]
  const stack = []
  let cur = heaviestId
  const seen = new Set()
  while (cur != null && !seen.has(cur)) {
    seen.add(cur)
    const node = byId.get(cur)
    if (node) stack.push(frameLabel(node.callFrame))
    cur = parent.get(cur)
  }

  return { sampledMs: +(sampledUs / 1000).toFixed(1), ranked, stack }
}

export function createLagProfiler({ dir, log = console, now = () => Date.now() } = {}) {
  if (!dir) throw new Error('lag profiler requires a dump directory')

  const session = new Session()
  let running = false
  let windowStartedAtMs = 0
  let previousWindow = null
  let tickTimer = null
  let windowTimer = null
  let lastDumpAtMs = 0
  let cutting = false
  const stats = { windows: 0, dumps: 0, suppressedDumps: 0, lastStallMs: 0, lastDumpAt: null }

  const post = (method, params) => new Promise((resolve, reject) => {
    session.post(method, params, (err, result) => (err ? reject(err) : resolve(result)))
  })

  async function startWindow() {
    await post('Profiler.start')
    windowStartedAtMs = now()
    stats.windows += 1
  }

  // Ends the current window and immediately opens the next one, so coverage is
  // continuous. Returns the profile that just closed.
  async function cutWindow() {
    const { profile } = await post('Profiler.stop')
    const closed = { profile, startedAtMs: windowStartedAtMs, endedAtMs: now() }
    previousWindow = closed
    await startWindow()
    return closed
  }

  async function rollWindow() {
    if (cutting) return
    cutting = true
    try {
      await cutWindow()
    } finally {
      cutting = false
    }
  }

  // A stall was observed over [stallStartMs, stallEndMs] of wall clock. Cut the
  // window that contains it and write the slice.
  async function dumpStall(stallStartMs, stallEndMs, lagMs) {
    if (cutting) return
    cutting = true
    try {
      const carried = previousWindow
      const closed = await cutWindow()

      // Map wall-clock to the profile's own microsecond timeline. The two share
      // an origin per window: profile.startTime corresponds to windowStartedAtMs.
      const windows = []
      if (carried && carried.endedAtMs >= stallStartMs) windows.push(carried)
      windows.push(closed)

      const sections = windows.map(w => {
        const originUs = w.profile.startTime
        const fromUs = originUs + (stallStartMs - w.startedAtMs) * 1000
        const toUs = originUs + (stallEndMs - w.startedAtMs) * 1000
        return summarizeProfile(w.profile, fromUs, toUs)
      }).filter(s => s.sampledMs > 0)

      const at = new Date(stallEndMs).toISOString()
      const report = {
        at,
        lagMs: +lagMs.toFixed(1),
        stallStart: new Date(stallStartMs).toISOString(),
        stallEnd: at,
        samplingIntervalUs: SAMPLING_INTERVAL_US,
        sections,
      }
      const file = join(dir, `lag-${at.replace(/[:.]/g, '-')}.json`)
      await writeFile(file, JSON.stringify(report, null, 2))

      const top = sections[0]?.ranked?.slice(0, 5) || []
      const headline = top.map(f => `${f.ms}ms ${f.label}`).join(' | ') || 'no samples in stall window'
      await appendFile(join(dir, 'lag-profiler.log'), `${at} lag=${report.lagMs}ms ${headline}\n`)
      log.warn?.(`[lag-profiler] ${report.lagMs}ms stall -> ${file} :: ${headline}`)

      stats.dumps += 1
      stats.lastDumpAt = at
      lastDumpAtMs = now()
    } finally {
      cutting = false
    }
  }

  // The deadline must be stamped when the timer is SCHEDULED, not when it fires —
  // read at fire time it can never be late, which is the whole measurement.
  function scheduleTick() {
    const expectedAtMs = now() + TICK_MS
    tickTimer = setTimeout(() => tick(expectedAtMs), TICK_MS)
    tickTimer.unref?.()
  }

  function tick(expectedAtMs) {
    const actualAtMs = now()
    const lagMs = actualAtMs - expectedAtMs
    scheduleTick()
    if (lagMs < STALL_MS) return
    stats.lastStallMs = lagMs
    if (actualAtMs - lastDumpAtMs < MIN_DUMP_GAP_MS) {
      stats.suppressedDumps += 1
      return
    }
    // Claim the rate-limit slot before the async dump so a second stall arriving
    // mid-dump cannot start a concurrent one.
    lastDumpAtMs = actualAtMs
    void dumpStall(expectedAtMs - TICK_MS, actualAtMs, lagMs)
  }

  async function start() {
    if (running) throw new Error('lag profiler already running')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    session.connect()
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US })
    await startWindow()
    running = true

    windowTimer = setInterval(() => { void rollWindow() }, WINDOW_MS)
    windowTimer.unref?.()
    scheduleTick()

    log.warn?.(`[lag-profiler] sampling every ${SAMPLING_INTERVAL_US}us, dumping stalls over ${STALL_MS}ms to ${dir}`)
  }

  async function stop() {
    if (!running) throw new Error('lag profiler is not running')
    running = false
    clearInterval(windowTimer)
    clearTimeout(tickTimer)
    await post('Profiler.stop')
    await post('Profiler.disable')
    session.disconnect()
  }

  return { start, stop, snapshot: () => ({ ...stats, running }) }
}
