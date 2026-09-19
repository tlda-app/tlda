// Always-on sampling profiler for the client, on the JS Self-Profiling API.
//
// Requires `Document-Policy: js-profiling` on the document response; the SPA
// handler in `server/unified-server.mjs` sends it. Without that header the
// `Profiler` constructor is absent and this reports itself unavailable.
//
// Sampling runs in 10-second windows, continuously. Every window is retained,
// oldest dropped first, bounded by count. A long task inside a window is
// recorded as a label on it; it does not decide whether the window is kept.
//
// Output is `.cpuprofile`, which speedscope, profview and Chrome DevTools read.
// Ranking and self-time accounting belong in those tools.
//
// Every window is also POSTed to `/api/client-profile-window`, which writes it
// to disk as its own `.cpuprofile`. Retention in this array is the tab's own
// copy and dies with the tab; the disk copy is the one anybody other than this
// document can open.

import { postLivePerf } from './livePerfUpload'
import { isAutomatedBrowser } from './cameraLink'
// One conversion, shared with the server, which is where uploaded windows are
// converted. Re-exported because callers of this module use it.
import { toCpuprofile } from '../shared/self-profile-to-cpuprofile.mjs'

export { toCpuprofile }

// ---------------------------------------------------------------- the platform API
//
// Typed here because TypeScript's DOM lib does not yet carry the self-profiling
// definitions. The shape is small and stable.

type ProfilerFrame = { name: string; resourceId?: number; line?: number; column?: number }
type ProfilerStack = { frameId: number; parentId?: number }
// `stackId` is ABSENT when the sample caught the thread doing nothing. Idle is
// an answer, so it maps to the root node rather than being dropped.
type ProfilerSample = { timestamp: number; stackId?: number }
export type ProfilerTrace = {
  resources: string[]
  frames: ProfilerFrame[]
  stacks: ProfilerStack[]
  samples: ProfilerSample[]
}

type SelfProfiler = {
  readonly sampleInterval: number
  readonly stopped: boolean
  stop: () => Promise<ProfilerTrace>
}

type ProfilerCtor = new (options: { sampleInterval: number; maxBufferSize: number }) => SelfProfiler

// 10ms is the self-profiling default and the interval the spec is written around.
const SAMPLE_INTERVAL_MS = 10
// Rolling window length. Short enough to bound one buffer, long enough that the
// stop/start cycle is not itself frequent work.
const WINDOW_MS = 10_000
// Buffer headroom for one window. At 10ms a full window is ~1000 samples.
const MAX_BUFFER_SIZE = 3000
// Retained span: 60 windows x 10s = the last ten minutes. Bounded because this
// runs for the life of the tab.
const MAX_RETAINED_WINDOWS = 60
// A window is MARKED, not gated, when it contains a task this long. 50ms is the
// platform's own `longtask` threshold.
const LONG_TASK_MS = 50

export type RetainedWindow = {
  at: string
  startedAt: number
  endedAt: number
  /** Longest task the platform reported inside this window, 0 if none. A label. */
  worstTaskMs: number
  sampleCount: number
  trace: ProfilerTrace
}

// An instrument that is silently not running is indistinguishable from one that
// ran and found nothing. `unavailable` therefore always carries its reason.
export type ProfilerState =
  | { status: 'running'; sampleIntervalMs: number; windows: number; retained: number; longTaskObserver: boolean }
  | { status: 'unavailable'; reason: string }
  | { status: 'stopped' }

// Names this tab in the window filenames on disk, so two tabs rolling in the
// same millisecond do not overwrite each other and leave the survivor looking
// like the only one that profiled.
const TAB_ID = Math.random().toString(36).slice(2, 10)

/**
 * Send one rolled window to the disk sink.
 *
 * Best effort and deliberately unawaited by the roll: a sink that is down must
 * cost the next window nothing, and the in-page copy is unaffected either way.
 */
function uploadWindow(rolled: RetainedWindow): void {
  // Only a human session is uploaded. The instrument is one browser a person
  // keeps open, and what it records is that person's experience of the app; a
  // playwright tab doing automation has no experience, and its windows would
  // both swamp the one session that matters and consume its retention.
  //
  // The profiler itself still RUNS in an automated tab — `window.__tldaProfiler`
  // stays available there — because that costs nothing and keeps the in-page
  // handle uniform. Only the upload is skipped.
  if (isAutomatedBrowser()) return
  try {
    void fetch('/api/client-profile-window', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // NOT `keepalive`. It caps the request body at 64 KB and a real window
      // runs to several hundred, so keepalive would drop precisely the busy
      // windows this exists to capture, silently. The cost is that a window
      // still in flight when the tab closes is lost, which costs one window
      // rather than every large one.
      body: JSON.stringify({
        at: rolled.at,
        tab: TAB_ID,
        href: location.href,
        worstTaskMs: rolled.worstTaskMs,
        sampleCount: rolled.sampleCount,
        windowMs: +(rolled.endedAt - rolled.startedAt).toFixed(1),
        // The RAW trace, converted by the server. Converting here costs a
        // median 2.8ms and up to 61ms of synchronous main-thread time on real
        // traces, and triples the bytes — an instrument that causes a long task
        // in the busy windows it exists to explain.
        trace: rolled.trace,
      }),
    }).catch(() => {
      // Upload is best effort; an asynchronous network failure must not break
      // the profiler that produced the window.
    })
  } catch (err) {
    // Swallowed deliberately: uploading a profile is best effort, and letting
    // it throw would take down the roll that produced the window and end the
    // continuous profile. Warned rather than silent so a sink that is always
    // failing is visible in the console.
    console.warn('[self-profiler] window upload failed', err)
  }
}

export type SelfProfilerHandle = {
  state: () => ProfilerState
  /** Every retained window, oldest first — not only the ones that were slow. */
  windows: () => RetainedWindow[]
  /** Close the current window and retain it now, rather than waiting for the interval. */
  cut: () => Promise<void>
  /**
   * Retained windows as `.cpuprofile`, newest last, optionally limited to those
   * overlapping the last `sinceMs` milliseconds. This is how "where did the time
   * go in the last ten minutes" gets answered: hand the output to speedscope.
   */
  cpuprofiles: (sinceMs?: number) => Array<{ at: string; worstTaskMs: number; profile: unknown }>
  /**
   * Main-thread milliseconds the profiler itself spent, per window cycle.
   * `minMs` is the estimate to read: noise only adds, so the floor across many
   * cycles is closest to the true cost.
   */
  overhead: () => { cycles: number; totalMs: number; meanMs: number; maxMs: number; minMs: number }
  stop: () => void
}

declare global {
  interface Window {
    __tldaProfiler?: SelfProfilerHandle
  }
}

export function installSelfProfiler(): SelfProfilerHandle {
  const Ctor = (window as unknown as { Profiler?: ProfilerCtor }).Profiler

  const overhead = { cycles: 0, totalMs: 0, maxMs: 0, minMs: Infinity }
  const retained: RetainedWindow[] = []
  let current: SelfProfiler | null = null
  // The browser may sample more coarsely than asked; record what it chose.
  let actualSampleIntervalMs = SAMPLE_INTERVAL_MS
  let windowStartedAt = 0
  let windows = 0
  let worstTaskMs = 0
  let timer: number | null = null
  let running = false
  let unavailableReason: string | null = null

  // Marks windows that contained a long task, so an agent can go straight to
  // them. It does NOT decide what is kept.
  let taskObserver: PerformanceObserver | null = null
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      taskObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (entry.duration > worstTaskMs) worstTaskMs = entry.duration
        }
      })
      taskObserver.observe({ entryTypes: ['longtask'] })
    } catch {
      // Losing the marker costs labelling, not coverage — every window is still
      // retained. `state()` reports it so the absence is not mistaken for
      // "nothing was ever slow".
      taskObserver = null
    }
  }

  const handle: SelfProfilerHandle = {
    state: () => {
      if (unavailableReason) return { status: 'unavailable', reason: unavailableReason }
      if (!running) return { status: 'stopped' }
      return {
        status: 'running',
        sampleIntervalMs: actualSampleIntervalMs,
        windows,
        retained: retained.length,
        longTaskObserver: taskObserver !== null,
      }
    },
    windows: () => retained,
    cut: () => rollWindow(),
    cpuprofiles: (sinceMs?: number) => {
      const cutoff = sinceMs != null ? performance.now() - sinceMs : -Infinity
      return retained
        .filter(w => w.endedAt >= cutoff)
        .map(w => ({ at: w.at, worstTaskMs: w.worstTaskMs, profile: toCpuprofile(w.trace) }))
    },
    overhead: () => ({
      cycles: overhead.cycles,
      totalMs: +overhead.totalMs.toFixed(1),
      meanMs: overhead.cycles ? +(overhead.totalMs / overhead.cycles).toFixed(2) : 0,
      maxMs: +overhead.maxMs.toFixed(2),
      // Scheduling noise only ever ADDS to a wall-clock measurement, so on a
      // contended machine the minimum across many cycles is the closest
      // estimate of the real cost. Read this one; the mean tracks the box.
      minMs: overhead.cycles ? +overhead.minMs.toFixed(2) : 0,
    }),
    stop: () => {
      running = false
      if (timer !== null) window.clearTimeout(timer)
      timer = null
      taskObserver?.disconnect()
      void current?.stop().catch(() => {})
      current = null
    },
  }

  if (!Ctor) {
    // Either the browser lacks the API or the document was served without
    // `Document-Policy: js-profiling`. Both produce the same absence, so name
    // both — a reader told only "unavailable" goes looking in the wrong half.
    unavailableReason = 'window.Profiler is absent — browser lacks the JS Self-Profiling API, or the document was served without the Document-Policy: js-profiling header'
    console.warn(`[self-profiler] NOT RUNNING: ${unavailableReason}`)
    postLivePerf({ kind: 'self-profiler-unavailable', reason: unavailableReason })
    window.__tldaProfiler = handle
    return handle
  }

  function startWindow(): boolean {
    try {
      current = new Ctor!({ sampleInterval: SAMPLE_INTERVAL_MS, maxBufferSize: MAX_BUFFER_SIZE })
      actualSampleIntervalMs = current.sampleInterval
      windowStartedAt = performance.now()
      worstTaskMs = 0
      windows += 1
      return true
    } catch (err) {
      unavailableReason = `Profiler constructor threw: ${(err as Error)?.message || String(err)}`
      running = false
      console.warn(`[self-profiler] NOT RUNNING: ${unavailableReason}`)
      postLivePerf({ kind: 'self-profiler-unavailable', reason: unavailableReason })
      return false
    }
  }

  async function rollWindow(): Promise<void> {
    const profiler = current
    if (!profiler || profiler.stopped) return
    const endedAt = performance.now()
    const taskMs = worstTaskMs
    // Read this window's start BEFORE the next one opens: `startWindow()`
    // reassigns `windowStartedAt`, so reading it afterwards would stamp every
    // retained window with its successor's start — an interval ending before it
    // begins.
    const startedAt = windowStartedAt

    // Open the next window before any accounting, so coverage stays continuous.
    const trace = await profiler.stop()
    if (running && !startWindow()) return

    const t0 = performance.now()
    retained.push({
      at: new Date().toISOString(),
      startedAt,
      endedAt,
      worstTaskMs: +taskMs.toFixed(1),
      sampleCount: trace.samples.length,
      trace,
    })
    if (retained.length > MAX_RETAINED_WINDOWS) {
      retained.splice(0, retained.length - MAX_RETAINED_WINDOWS)
    }

    // Every window goes to disk, quiet ones included. Which windows are
    // interesting is a question for whoever opens them, and answering it here
    // would be the summarizing this instrument exists to avoid.
    uploadWindow(retained[retained.length - 1])

    // A window that contained a long task is worth a line through the transport
    // that already exists, so it survives the tab closing. Deliberately a
    // POINTER, not a summary: no ranking is computed here. The profile itself
    // stays in the page and comes out through `cpuprofiles()`.
    if (taskMs >= LONG_TASK_MS) {
      postLivePerf({
        kind: 'self-profile-long-task',
        at: retained[retained.length - 1].at,
        worstTaskMs: +taskMs.toFixed(1),
        sampleCount: trace.samples.length,
        windowMs: +(endedAt - startedAt).toFixed(1),
      })
    }
    const cost = performance.now() - t0
    overhead.cycles += 1
    overhead.totalMs += cost
    if (cost > overhead.maxMs) overhead.maxMs = cost
    if (cost < overhead.minMs) overhead.minMs = cost
  }

  function scheduleRoll(): void {
    timer = window.setTimeout(() => {
      void rollWindow().catch(err => {
        console.warn('[self-profiler] window roll failed', err)
      })
      if (running) scheduleRoll()
    }, WINDOW_MS)
  }

  running = true
  if (startWindow()) {
    scheduleRoll()
    console.info(`[self-profiler] running, sampling every ${actualSampleIntervalMs}ms, retaining the last ${MAX_RETAINED_WINDOWS} windows`)
  }

  window.__tldaProfiler = handle
  return handle
}
