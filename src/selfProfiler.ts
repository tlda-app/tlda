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

import { postLivePerf } from './livePerfUpload'

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

/**
 * Convert one self-profiling trace to the `.cpuprofile` shape.
 *
 * This is the whole analysis path, and deliberately the only one: `.cpuprofile`
 * is what speedscope, profview and Chrome DevTools already open, so nothing
 * here has to grow a ranker or a viewer.
 */
export function toCpuprofile(trace: ProfilerTrace): unknown {
  // `.cpuprofile` node ids are 1-based and every node needs a callFrame. The
  // stack table maps across one-for-one, with an added root carrying the samples
  // that have no stack.
  const ROOT_ID = 1
  const nodes: Array<{
    id: number
    callFrame: { functionName: string; scriptId: string; url: string; lineNumber: number; columnNumber: number }
    children?: number[]
  }> = [{
    id: ROOT_ID,
    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
  }]

  const childrenOf = new Map<number, Set<number>>([[ROOT_ID, new Set()]])
  trace.stacks.forEach((entry, index) => {
    const id = index + 2 // 1 is the root
    const frame = trace.frames[entry.frameId]
    const url = frame?.resourceId != null ? trace.resources[frame.resourceId] || '' : ''
    nodes.push({
      id,
      callFrame: {
        functionName: frame?.name || '(anonymous)',
        scriptId: String(frame?.resourceId ?? 0),
        url,
        lineNumber: (frame?.line ?? 1) - 1,
        columnNumber: (frame?.column ?? 1) - 1,
      },
    })
    const parent = entry.parentId != null ? entry.parentId + 2 : ROOT_ID
    if (!childrenOf.has(parent)) childrenOf.set(parent, new Set())
    childrenOf.get(parent)!.add(id)
  })

  for (const node of nodes) {
    const kids = childrenOf.get(node.id)
    if (kids && kids.size) node.children = [...kids]
  }

  // `.cpuprofile` timestamps are microseconds; self-profiling gives milliseconds.
  const samples = trace.samples.map(s => (s.stackId != null ? s.stackId + 2 : ROOT_ID))
  const timeDeltas = trace.samples.map((s, i) =>
    i === 0 ? 0 : Math.max(0, Math.round((s.timestamp - trace.samples[i - 1].timestamp) * 1000)))
  const startTime = Math.round((trace.samples[0]?.timestamp ?? 0) * 1000)
  const endTime = Math.round((trace.samples[trace.samples.length - 1]?.timestamp ?? 0) * 1000)

  return { nodes, startTime, endTime, samples, timeDeltas }
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
