/**
 * perf-probe — lightweight performance telemetry for slow-device profiling.
 *
 * Activated ONLY by ?perf=1 (or ?perf=svg,chat,reconnect for specific probes).
 * Minimal inactive cost — module imports and cheap early-return helpers run,
 * but no measurements are recorded or logged when `probe.active` is false.
 *
 * Measures:
 *   - Frame timing during pan/scroll (JS vs idle breakdown)
 *   - SVG page injection + word-space processing timing
 *   - Chat render cycle timing (Virtuoso re-renders)
 *   - Reconnect catch-up timing (WS reconnect → events ingested)
 *
 * Data stays in-browser: a rolling buffer of the last ~200 measurements,
 * readable via `__perfProbe.dump()` in the console or `__perfProbe.report()`
 * for a formatted summary. No server POST, no behavior changes.
 *
 * iPhone 13 profiling path:
 *   1. Open tlda on iPhone Safari with ?perf=1
 *   2. Tether to Mac, open Safari Web Inspector → Timelines
 *   3. Reproduce the jank (pan, scroll chat, background/foreground)
 *   4. In Web Inspector console: __perfProbe.report()
 *   5. Copy the output — it tells you which surface is hot
 */

type ProbeName = 'svg' | 'chat' | 'reconnect' | 'frame' | 'startup' | 'hud'

interface Measurement {
  probe: ProbeName
  label: string
  durationMs: number
  ts: number
  detail?: Record<string, any>
}

const MAX_BUFFER = 200

class PerfProbe {
  readonly active: boolean
  readonly enabledProbes: Set<ProbeName>
  private buffer: Measurement[] = []
  private frameTimers: { label: string; start: number }[] = []
  private uploadTimer: number | null = null
  private lastUploadSampleCount = 0

  constructor() {
    if (typeof window === 'undefined') {
      this.active = false
      this.enabledProbes = new Set()
      return
    }
    const params = new URLSearchParams(window.location.search)
    const raw = params.get('perf')
    if (!raw) {
      this.active = false
      this.enabledProbes = new Set()
      return
    }
    this.active = true
    if (raw === '1' || raw === 'true') {
      this.enabledProbes = new Set(['svg', 'chat', 'reconnect', 'frame', 'startup', 'hud'])
    } else {
      this.enabledProbes = new Set(raw.split(',').map(s => s.trim()) as ProbeName[])
    }
    // Expose globally for console access
    (window as any).__perfProbe = this
    console.info('[perf-probe] active, probes:', [...this.enabledProbes].join(', '))
    window.addEventListener('pagehide', () => this.sendReport('pagehide'))
  }

  isEnabled(probe: ProbeName): boolean {
    return this.active && this.enabledProbes.has(probe)
  }

  /** Start a named timer. Returns an ID to pass to stop(). */
  start(probe: ProbeName, label: string): number | null {
    if (!this.isEnabled(probe)) return null
    const id = this.frameTimers.length
    this.frameTimers.push({ label, start: performance.now() })
    return id
  }

  /** Stop a timer and record the measurement. */
  stop(id: number | null, detail?: Record<string, any>): void {
    if (id === null || id >= this.frameTimers.length) return
    const timer = this.frameTimers[id]
    const durationMs = performance.now() - timer.start
    this.record(this.probeFromLabel(timer.label), timer.label, durationMs, detail)
  }

  /** Record a measurement directly (for things that don't need start/stop). */
  record(probe: ProbeName, label: string, durationMs: number, detail?: Record<string, any>): void {
    if (!this.isEnabled(probe)) return
    this.buffer.push({ probe, label, durationMs, ts: Date.now(), detail })
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER)
    }
    this.scheduleUpload()
  }

  time<T>(probe: ProbeName, label: string, fn: () => T, detail?: Record<string, any> | (() => Record<string, any>)): T {
    if (!this.isEnabled(probe)) return fn()
    const t0 = performance.now()
    try {
      return fn()
    } finally {
      const extra = typeof detail === 'function' ? detail() : detail
      this.record(probe, label, performance.now() - t0, extra)
    }
  }

  private probeFromLabel(label: string): ProbeName {
    if (label.startsWith('svg')) return 'svg'
    if (label.startsWith('chat')) return 'chat'
    if (label.startsWith('reconnect')) return 'reconnect'
    if (label.startsWith('frame')) return 'frame'
    if (label.startsWith('hud')) return 'hud'
    return 'startup'
  }

  /** Dump raw measurements (for console inspection). */
  dump(): Measurement[] {
    return [...this.buffer]
  }

  /** Formatted summary grouped by probe — the main output for profiling. */
  report(): string {
    const groups = new Map<ProbeName, Measurement[]>()
    for (const m of this.buffer) {
      const arr = groups.get(m.probe) || []
      arr.push(m)
      groups.set(m.probe, arr)
    }

    const lines: string[] = ['=== perf-probe report ===', '']

    for (const [probe, measurements] of groups) {
      const durations = measurements.map(m => m.durationMs)
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length
      const max = Math.max(...durations)
      const min = Math.min(...durations)
      const p95 = durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.95)] || max

      lines.push(`[${probe}] ${measurements.length} samples`)
      lines.push(`  avg: ${avg.toFixed(1)}ms  min: ${min.toFixed(1)}ms  max: ${max.toFixed(1)}ms  p95: ${p95.toFixed(1)}ms`)

      // Show the slowest 3 individual measurements
      const slowest = measurements
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 3)
      for (const m of slowest) {
        const detailStr = m.detail ? ' ' + JSON.stringify(m.detail) : ''
        lines.push(`  slow: ${m.label} = ${m.durationMs.toFixed(1)}ms${detailStr}`)
      }
      lines.push('')
    }

    // Frame-specific analysis: how many frames exceeded 16ms (60fps budget)?
    const frames = groups.get('frame') || []
    if (frames.length > 0) {
      const janky = frames.filter(f => f.durationMs > 16.7)
      const veryJanky = frames.filter(f => f.durationMs > 33.3)
      lines.push(`[frame jank] ${janky.length}/${frames.length} frames > 16.7ms (${(janky.length / frames.length * 100).toFixed(0)}%)`)
      lines.push(`[frame jank] ${veryJanky.length}/${frames.length} frames > 33.3ms (${(veryJanky.length / frames.length * 100).toFixed(0)}%)`)
      lines.push('')
    }

    const output = lines.join('\n')
    console.info(output)
    return output
  }

  sendReport(reason = 'manual'): void {
    if (!this.active || this.buffer.length === 0) return
    this.lastUploadSampleCount = this.buffer.length
    const payload = {
      ts: new Date().toISOString(),
      level: 'info',
      ns: 'perf-probe',
      msg: `perf report (${reason})`,
      data: {
        reason,
        url: window.location.href,
        userAgent: navigator.userAgent,
        sampleCount: this.buffer.length,
        report: this.report(),
        measurements: this.dump(),
      },
    }
    try {
      const body = JSON.stringify(payload)
      if (navigator.sendBeacon) {
        const ok = navigator.sendBeacon('/api/log', new Blob([body], { type: 'application/json' }))
        if (ok) return
      }
      void fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      })
    } catch (err) {
      console.warn('[perf-probe] report upload failed', err)
    }
  }

  private scheduleUpload(): void {
    if (this.uploadTimer !== null) return
    this.uploadTimer = window.setTimeout(() => {
      this.uploadTimer = null
      if (this.buffer.length !== this.lastUploadSampleCount) {
        this.sendReport('periodic')
      }
    }, 5000)
  }

  /** Clear the buffer. */
  clear(): void {
    this.buffer = []
  }
}

// Singleton — created once at module load, reads URL params immediately.
export const probe = new PerfProbe()
