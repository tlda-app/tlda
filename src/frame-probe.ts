/**
 * frame-probe — real-session frame health during user interactions.
 *
 * Enable with `?perf=frame` / `?perf=1`, or persist for Skip's real session with:
 *   localStorage.setItem('tlda-perf', 'frame')
 *
 * Emits low-volume `perf-probe` reports to ~/.config/tlda/client.log via /api/log.
 */
import { probe } from './perf-probe'

declare global {
  interface Window {
    __tldraw_editor__?: {
      getCamera?: () => { x: number; y: number; z: number }
    }
    __frameProbe?: {
      flush: () => void
      stop: () => void
    }
  }
}

type LoafSummary = {
  duration: number
  blockingDuration?: number
  renderStart?: number
  styleAndLayoutStart?: number
  scripts?: Array<{
    duration: number
    invoker?: string
    sourceURL?: string
    forcedStyleAndLayoutDuration?: number
  }>
}

type InteractionSample = {
  start: number
  lastEvent: number
  events: Record<string, number>
  frames: number[]
  worst: number[]
  loafs: LoafSummary[]
  longTasks: Array<{ duration: number; name: string; startTime: number }>
  layoutReads: {
    getBBox: number
    getBoundingClientRect: number
    frames: number
    maxPerFrame: number
    currentFrame: number
    currentFrameGetBBox: number
    currentFrameGetBoundingClientRect: number
    worstFrames: Array<{
      total: number
      getBBox: number
      getBoundingClientRect: number
    }>
    targets: Record<string, number>
  }
}

type LoafScriptTiming = NonNullable<LoafSummary['scripts']>[number]
type LoafPerformanceEntry = PerformanceEntry & {
  blockingDuration?: number
  renderStart?: number
  styleAndLayoutStart?: number
  scripts?: LoafScriptTiming[]
}

const INTERACTION_IDLE_MS = 900
const MAX_WORST = 12
const MAX_LOAFS = 8
const MAX_LONG_TASKS = 8
const MAX_LAYOUT_READ_FRAMES = 8
const MAX_LAYOUT_READ_TARGETS = 12

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

function visiblePageCount() {
  return document.querySelectorAll('[data-shape-type="svg-page"], [data-shape-id*="-page-"]').length
}

function visibleDocviewCount() {
  return document.querySelectorAll('.fleet-docview [data-viewport-id]').length
}

if (probe.isEnabled('frame')) {
  let interaction: InteractionSample | null = null
  let lastFrameTime = performance.now()
  let rafId = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const classifyLayoutReadTarget = (target: unknown) => {
    if (!(target instanceof Element)) return 'unknown'
    const shape = target.closest?.('[data-shape-type], .fleet-shape, .fleet-docview')
    const shapeType = shape?.getAttribute?.('data-shape-type')
    if (shapeType) return shapeType
    if (shape?.classList?.contains('fleet-docview')) return 'fleet-docview'
    if (shape?.classList?.contains('fleet-shape')) return 'fleet-shape'
    if (target.closest?.('.fleet-hud-wrap')) return 'fleet-hud'
    if (target.closest?.('[data-shape-type="svg-page"]')) return 'svg-page'
    const tag = target.tagName.toLowerCase()
    const cls = typeof target.className === 'string' ? target.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
    return cls ? `${tag}.${cls}` : tag
  }

  const recordLayoutRead = (kind: 'getBBox' | 'getBoundingClientRect', target: unknown) => {
    if (!interaction) return
    interaction.layoutReads[kind] += 1
    interaction.layoutReads.currentFrame += 1
    if (kind === 'getBBox') interaction.layoutReads.currentFrameGetBBox += 1
    else interaction.layoutReads.currentFrameGetBoundingClientRect += 1
    const key = `${kind}:${classifyLayoutReadTarget(target)}`
    interaction.layoutReads.targets[key] = (interaction.layoutReads.targets[key] || 0) + 1
  }

  const installLayoutReadProbe = () => {
    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function getBoundingClientRectProbe(...args) {
      recordLayoutRead('getBoundingClientRect', this)
      return originalGetBoundingClientRect.apply(this, args)
    }

    const svgGraphicsPrototype = typeof SVGGraphicsElement !== 'undefined' ? SVGGraphicsElement.prototype : null
    const originalGetBBox = svgGraphicsPrototype?.getBBox
    if (svgGraphicsPrototype && originalGetBBox) {
      svgGraphicsPrototype.getBBox = function getBBoxProbe(...args) {
        recordLayoutRead('getBBox', this)
        return originalGetBBox.apply(this, args)
      }
    }

    return () => {
      Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
      if (svgGraphicsPrototype && originalGetBBox) {
        svgGraphicsPrototype.getBBox = originalGetBBox
      }
    }
  }

  const beginOrExtendInteraction = (eventType: string) => {
    const now = performance.now()
    if (!interaction) {
      interaction = {
        start: now,
        lastEvent: now,
        events: {},
        frames: [],
        worst: [],
        loafs: [],
        longTasks: [],
        layoutReads: {
          getBBox: 0,
          getBoundingClientRect: 0,
          frames: 0,
          maxPerFrame: 0,
          currentFrame: 0,
          currentFrameGetBBox: 0,
          currentFrameGetBoundingClientRect: 0,
          worstFrames: [],
          targets: {},
        },
      }
    }
    interaction.lastEvent = now
    interaction.events[eventType] = (interaction.events[eventType] || 0) + 1

    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(flushInteraction, INTERACTION_IDLE_MS)
  }

  const recordWorst = (duration: number) => {
    if (!interaction) return
    interaction.worst.push(duration)
    interaction.worst.sort((a, b) => b - a)
    if (interaction.worst.length > MAX_WORST) interaction.worst.length = MAX_WORST
  }

  const flushInteraction = () => {
    flushTimer = null
    if (!interaction || interaction.frames.length === 0) {
      interaction = null
      return
    }

    const frames = interaction.frames
    const sorted = [...frames].sort((a, b) => a - b)
    const max = Math.max(...frames)
    const over33 = frames.filter(f => f > 33.3).length
    const over50 = frames.filter(f => f > 50).length
    const over100 = frames.filter(f => f > 100).length
    const over250 = frames.filter(f => f > 250).length
    const editor = window.__tldraw_editor__
    const camera = editor?.getCamera?.()

    probe.record('frame', 'frame-health', max, {
      durationMs: performance.now() - interaction.start,
      eventSpanMs: interaction.lastEvent - interaction.start,
      eventTypes: interaction.events,
      frameCount: frames.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      over33,
      over50,
      over100,
      over250,
      worst: interaction.worst,
      loafs: interaction.loafs,
      longTasks: interaction.longTasks,
      layoutReads: {
        getBBox: interaction.layoutReads.getBBox,
        getBoundingClientRect: interaction.layoutReads.getBoundingClientRect,
        frames: interaction.layoutReads.frames,
        maxPerFrame: interaction.layoutReads.maxPerFrame,
        worstFrames: interaction.layoutReads.worstFrames,
        topTargets: Object.entries(interaction.layoutReads.targets)
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_LAYOUT_READ_TARGETS)
          .map(([target, count]) => ({ target, count })),
      },
      camera: camera ? { x: camera.x, y: camera.y, z: camera.z } : undefined,
      visiblePageCount: visiblePageCount(),
      visibleDocviewCount: visibleDocviewCount(),
      doc: new URLSearchParams(window.location.search).get('doc') || undefined,
    })

    interaction = null
  }

  const measureFrame = (now: number) => {
    const duration = now - lastFrameTime
    lastFrameTime = now
    if (interaction) {
      const reads = interaction.layoutReads.currentFrame
      if (reads > 0) {
        interaction.layoutReads.frames += 1
        interaction.layoutReads.maxPerFrame = Math.max(interaction.layoutReads.maxPerFrame, reads)
        interaction.layoutReads.worstFrames.push({
          total: reads,
          getBBox: interaction.layoutReads.currentFrameGetBBox,
          getBoundingClientRect: interaction.layoutReads.currentFrameGetBoundingClientRect,
        })
        interaction.layoutReads.worstFrames.sort((a, b) => b.total - a.total)
        if (interaction.layoutReads.worstFrames.length > MAX_LAYOUT_READ_FRAMES) {
          interaction.layoutReads.worstFrames.length = MAX_LAYOUT_READ_FRAMES
        }
        interaction.layoutReads.currentFrame = 0
        interaction.layoutReads.currentFrameGetBBox = 0
        interaction.layoutReads.currentFrameGetBoundingClientRect = 0
      }
      interaction.frames.push(duration)
      if (duration > 33.3) recordWorst(duration)
    }
    rafId = requestAnimationFrame(measureFrame)
  }

  const interactionEvents = ['wheel', 'pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'touchend', 'keydown']
  for (const eventType of interactionEvents) {
    window.addEventListener(eventType, () => beginOrExtendInteraction(eventType), { capture: true, passive: true })
  }

  try {
    const observer = new PerformanceObserver(list => {
      if (!interaction) return
      for (const baseEntry of list.getEntries()) {
        const entry = baseEntry as LoafPerformanceEntry
        interaction.loafs.push({
          duration: entry.duration,
          blockingDuration: entry.blockingDuration,
          renderStart: entry.renderStart,
          styleAndLayoutStart: entry.styleAndLayoutStart,
          scripts: (entry.scripts || []).map(script => ({
            duration: script.duration,
            invoker: script.invoker,
            sourceURL: script.sourceURL,
            forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
          })),
        })
      }
      interaction.loafs.sort((a, b) => b.duration - a.duration)
      if (interaction.loafs.length > MAX_LOAFS) interaction.loafs.length = MAX_LOAFS
    })
    observer.observe({ type: 'long-animation-frame', buffered: false })
  } catch {
    // Long Animation Frame is Chromium-only. rAF timing still works elsewhere.
  }

  try {
    const observer = new PerformanceObserver(list => {
      if (!interaction) return
      for (const entry of list.getEntries()) {
        interaction.longTasks.push({
          duration: entry.duration,
          name: entry.name,
          startTime: entry.startTime,
        })
      }
      interaction.longTasks.sort((a, b) => b.duration - a.duration)
      if (interaction.longTasks.length > MAX_LONG_TASKS) interaction.longTasks.length = MAX_LONG_TASKS
    })
    observer.observe({ type: 'longtask', buffered: false })
  } catch {
    // Long Task is unavailable in some browsers.
  }

  window.addEventListener('pagehide', flushInteraction)
  const uninstallLayoutReadProbe = installLayoutReadProbe()
  rafId = requestAnimationFrame(measureFrame)

  window.__frameProbe = {
    flush: flushInteraction,
    stop() {
      cancelAnimationFrame(rafId)
      if (flushTimer) clearTimeout(flushTimer)
      flushInteraction()
      uninstallLayoutReadProbe()
    },
  }

  console.info('[frame-probe] measuring real-session frame health')
}
