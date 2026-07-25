/**
 * Client-side performance capture. Two hooks, one self-profiler:
 *   - usePanPerfLog        — frame-health during a camera pan/zoom gesture.
 *   - useLongTaskProfileLog — a JS self-profile whenever the main thread stalls.
 *
 * usePanPerfLog — sample camera-pan frame-health and POST it to the client log.
 *
 * Captures real on-device numbers (median/max frame delta, dropped-frame count,
 * zoom, visible SVG node count) during an active camera pan/zoom gesture, so a
 * user's actual hardware + gesture + zoom can be read out of
 * ~/.config/tlda/client.log instead of being reproduced on another machine.
 *
 * It logs once per gesture and only for gestures long enough to be meaningful
 * (MIN_FRAMES) — no idle spam. It goes through the standard logger at `info`
 * level: below the default `warn` console threshold, so nothing shows in the
 * user's DevTools, but it is always POSTed to the server sink. No UI.
 */
import { useEffect } from 'react'
import type { RefObject } from 'react'
import { react, type Editor } from 'tldraw'
import { log } from '../logger'
import { isAutomatedBrowser } from '../cameraLink'

const GESTURE_END_MS = 200 // camera quiet for this long ends the gesture
const MIN_FRAMES = 12 // ignore tiny nudges
const PROFILE_SAMPLE_INTERVAL_MS = 10
const PROFILE_MAX_BUFFER_SIZE = 2_000
const PROFILE_SLOW_FRAME_MS = 50
// Stall size worth a stack. Tuned against Skip's measured session, not guessed:
// his long-task p50 is ~72ms and p90 ~248ms, so the original 200ms threshold sat
// above almost everything he actually feels and the 15s gap threw the rest away.
// The existing observer in livePerfProbe still records EVERY task over 50ms for
// frequency; these caps only bound how many get a full stack attached.
const LONGTASK_PROFILE_MS = 150
const MAX_LONGTASK_PROFILES = 30
const LONGTASK_PROFILE_MIN_GAP_MS = 5_000

type PanSummary = {
  frames: number
  median: number
  p95: number
  max: number
  over33: number
  over50: number
  zoom: number
  nodes: number
  pages: number
  dx: number
  dy: number
  directionX: -1 | 0 | 1
}

type SelfProfilingTrace = {
  samples?: unknown[]
  stacks?: unknown[]
  resources?: unknown[]
  frames?: unknown[]
}

type SelfProfiler = {
  stop: () => Promise<SelfProfilingTrace>
}

type ProfilerConstructor = new (options: {
  sampleInterval: number
  maxBufferSize: number
}) => SelfProfiler

declare global {
  interface Window {
    Profiler?: ProfilerConstructor
  }
}

function startSelfProfiler(): SelfProfiler | null {
  const Profiler = window.Profiler
  if (typeof Profiler !== 'function') return null
  try {
    return new Profiler({
      sampleInterval: PROFILE_SAMPLE_INTERVAL_MS,
      maxBufferSize: PROFILE_MAX_BUFFER_SIZE,
    })
  } catch {
    return null
  }
}

function hasReadableFrameName(trace: SelfProfilingTrace) {
  return Array.isArray(trace.frames) && trace.frames.some((frame) => {
    if (!frame || typeof frame !== 'object') return false
    const name = (frame as { name?: unknown }).name
    return typeof name === 'string' && name.length > 0
  })
}

function postProfile(kind: string, summary: unknown, trace: SelfProfilingTrace) {
  const record = {
    ts: new Date().toISOString(),
    kind,
    doc: new URLSearchParams(window.location.search).get('doc') || undefined,
    href: window.location.href,
    summary,
    readableStacks: hasReadableFrameName(trace),
    trace,
  }
  void fetch('/api/client-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  }).catch(() => {})
}

/**
 * useLongTaskProfileLog — the same self-profiler, pointed at main-thread stalls
 * instead of only at pan gestures.
 *
 * Why it is shaped as a ROLLING profiler rather than "start one when a long task
 * fires": the JS Self-Profiling API can only sample code that runs *after* the
 * profiler starts. A stall cannot be captured retroactively. So one profiler runs
 * continuously and the long-task observer *stops and posts* it — the trace it
 * returns already contains the stall that just happened. A fresh one starts
 * immediately after.
 *
 * `maxBufferSize` at a 10ms interval bounds the rolling window to roughly 20s, and
 * the profiler stops itself when that buffer fills, so this cannot grow without
 * limit. Posts are capped and rate-limited: a janky page fires long tasks
 * continuously, and the point is to name what is eating the main thread, not to
 * flood the sink.
 *
 * Independent of the editor — stalls are stalls whether or not tldraw has mounted.
 * No UI. Unsupported browsers (no `window.Profiler`) bail and cost nothing.
 */
export function useLongTaskProfileLog() {
  useEffect(() => {
    if (typeof window.Profiler !== 'function') return
    if (typeof PerformanceObserver === 'undefined') return
    // Never profile an automated session. Agent playwright tabs stall harder than
    // the real user does, and they burned 4 of the first 5 profiles ever captured —
    // spending the budget measuring ourselves and polluting the attribution.
    if (isAutomatedBrowser()) return

    let profiler: SelfProfiler | null = null
    let posted = 0
    let lastPostAt = 0
    let stopped = false
    let restartTimer: ReturnType<typeof setTimeout> | null = null

    const arm = () => {
      if (stopped || profiler) return
      profiler = startSelfProfiler()
    }

    // Stop the rolling profiler, post what it captured, and re-arm.
    const captureStall = (entry: PerformanceEntry) => {
      const active = profiler
      profiler = null
      if (!active) { arm(); return }
      posted += 1
      lastPostAt = Date.now()
      void active.stop().then(trace => {
        if (trace) {
          postProfile('longtask-profile', {
            name: entry.name,
            startTime: Math.round(entry.startTime),
            duration: Math.round(entry.duration),
            threshold: LONGTASK_PROFILE_MS,
          }, trace)
        }
      }).catch(() => {}).finally(() => {
        // Re-arm on the next turn so the fresh profiler does not start inside the
        // same task that just stalled.
        if (restartTimer != null) clearTimeout(restartTimer)
        restartTimer = setTimeout(arm, 0)
      })
    }

    let observer: PerformanceObserver | null = null
    try {
      observer = new PerformanceObserver(list => {
        if (stopped) return
        for (const entry of list.getEntries()) {
          if (entry.duration < LONGTASK_PROFILE_MS) continue
          if (posted >= MAX_LONGTASK_PROFILES) return
          if (Date.now() - lastPostAt < LONGTASK_PROFILE_MIN_GAP_MS) continue
          captureStall(entry)
          return
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      observer = null
      return
    }

    arm()

    return () => {
      stopped = true
      if (restartTimer != null) clearTimeout(restartTimer)
      observer?.disconnect()
      const active = profiler
      profiler = null
      void active?.stop().catch(() => {})
    }
  }, [])
}

export function usePanPerfLog(editorRef: RefObject<Editor | null>, editorMounted: number) {
  useEffect(() => {
    // editorMounted is a re-run trigger: the tldraw editor mounts asynchronously
    // (after this effect first runs), so editorRef.current is null on the initial
    // pass. SvgDocument bumps editorMounted in onMount, which re-runs this effect
    // with the editor available so the camera reaction actually installs.
    const editor = editorRef.current
    if (!editor) return

    let active = false
    let rafId: number | null = null
    let lastTs = 0
    let deltas: number[] = []
    let endTimer: ReturnType<typeof setTimeout> | null = null
    let prev = editor.getCamera()
    let startCamera = prev
    let startNodes = 0
    let startPages = 0
    let profiler: SelfProfiler | null = null

    const tick = (ts: number) => {
      if (!active) { rafId = null; return }
      if (lastTs) deltas.push(ts - lastTs)
      lastTs = ts
      rafId = requestAnimationFrame(tick)
    }

    const visibleSvgPages = () => {
      const viewport = editor.getViewportScreenBounds()
      const pageIds = new Set(
        editor.getCurrentPageShapes()
          .filter((shape) => (shape.type as string) === 'svg-page')
          .map((shape) => shape.id as string),
      )
      const pages: Element[] = []
      for (const el of document.querySelectorAll('[data-shape-id]')) {
        const id = el.getAttribute('data-shape-id')
        if (!id || !pageIds.has(id) || !el.querySelector('svg')) continue
        const rect = el.getBoundingClientRect()
        if (rect.right < viewport.x || rect.left > viewport.x + viewport.w || rect.bottom < viewport.y || rect.top > viewport.y + viewport.h) continue
        pages.push(el)
      }
      return pages
    }

    const visibleNodes = () => {
      let n = 0
      for (const el of visibleSvgPages()) {
        n += el.querySelectorAll('path,use,text,tspan').length
      }
      return n
    }

    const endGesture = async () => {
      endTimer = null
      active = false
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null }
      const d = deltas
      deltas = []
      lastTs = 0
      const activeProfiler = profiler
      profiler = null
      const tracePromise = activeProfiler?.stop().catch(() => null) ?? Promise.resolve(null)
      if (d.length < MIN_FRAMES) {
        await tracePromise
        return
      }
      const sorted = [...d].sort((a, b) => a - b)
      const cam = editor.getCamera()
      const dx = cam.x - startCamera.x
      const dy = cam.y - startCamera.y
      const summary: PanSummary = {
        frames: d.length,
        median: Math.round(sorted[Math.floor(sorted.length / 2)]),
        p95: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
        max: Math.round(Math.max(...d)),
        over33: d.filter((x) => x > 33).length,
        over50: d.filter((x) => x > 50).length,
        zoom: Number(cam.z.toFixed(3)),
        nodes: startNodes,
        pages: startPages,
        dx: Math.round(dx),
        dy: Math.round(dy),
        directionX: dx > 0 ? 1 : dx < 0 ? -1 : 0,
      }
      // metric() is sink-only (no console, no level gate) so these land in the
      // client log by default — pan frame-health from a user's real device.
      log.metric('pan-perf', 'pan', summary)
      if (summary.max > PROFILE_SLOW_FRAME_MS || summary.over50 >= 1) {
        const trace = await tracePromise
        if (trace) postProfile('pan-profile', summary, trace)
      } else {
        await tracePromise
      }
    }

    // Reaction fires on every camera change (~1/frame during a pan). It only
    // arms a frame-sampling rAF loop and a debounced gesture-end timer; the
    // actual frame deltas come from the rAF loop, not from this callback.
    const stop = react('pan-perf', () => {
      const cam = editor.getCamera() // subscribe to camera changes
      if (cam.x === prev.x && cam.y === prev.y && cam.z === prev.z) return
      prev = cam
      if (!active) {
        active = true
        deltas = []
        lastTs = 0
        startCamera = cam
        startNodes = visibleNodes()
        startPages = visibleSvgPages().length
        profiler = startSelfProfiler()
        rafId = requestAnimationFrame(tick)
      }
      if (endTimer != null) clearTimeout(endTimer)
      endTimer = setTimeout(endGesture, GESTURE_END_MS)
    })

    return () => {
      stop()
      if (rafId != null) cancelAnimationFrame(rafId)
      if (endTimer != null) clearTimeout(endTimer)
      const activeProfiler = profiler
      profiler = null
      void activeProfiler?.stop().catch(() => {})
    }
  }, [editorRef, editorMounted])
}
