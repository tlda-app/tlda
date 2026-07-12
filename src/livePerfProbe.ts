import type { Editor } from 'tldraw'
import type { SvgDocument } from './svgDocumentLoader'
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals/attribution'
import type { MetricWithAttribution } from 'web-vitals/attribution'

type LivePerfProbeHandle = {
  sample: (reason?: string) => void
  stop: () => void
}

type BrowserMemory = {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

declare global {
  interface Window {
    __livePerfProbe?: LivePerfProbeHandle
  }
}

const SAMPLE_INTERVAL_MS = 10_000
const LIVE_PERF_VERSION = 1

function livePerfEnabled() {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  const urlPerf = params.get('perf') || ''
  const storedPerf = localStorage.getItem('tlda-perf') || ''
  const values = [urlPerf, storedPerf]
  return values.some(value => value === '1' || value === 'true' || value.split(',').map(v => v.trim()).includes('live'))
}

function countBy<T extends string>(values: T[]) {
  const out: Record<string, number> = {}
  for (const value of values) out[value] = (out[value] || 0) + 1
  return out
}

function summarizeHtmlPages(shapes: any[]) {
  const htmlPages = shapes.filter(shape => shape?.typeName === 'shape' && shape?.type === 'html-page')
  const byPage = countBy(htmlPages.map(shape => String(shape.parentId || 'unknown')))
  const heights = htmlPages
    .map(shape => Number(shape.props?.h))
    .filter(height => Number.isFinite(height))
    .sort((a, b) => a - b)
  const widths = htmlPages
    .map(shape => Number(shape.props?.w))
    .filter(width => Number.isFinite(width))
    .sort((a, b) => a - b)
  const sorted = [...htmlPages].sort((a, b) => {
    const pageCmp = String(a.parentId || '').localeCompare(String(b.parentId || ''))
    if (pageCmp !== 0) return pageCmp
    return Number(a.y || 0) - Number(b.y || 0)
  })
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]
    const next = sorted[i]
    if (prev.parentId !== next.parentId) continue
    const prevBottom = Number(prev.y || 0) + Number(prev.props?.h || 0)
    const gap = Number(next.y || 0) - prevBottom
    if (Number.isFinite(gap)) gaps.push(gap)
  }
  gaps.sort((a, b) => a - b)
  return {
    count: htmlPages.length,
    byPage,
    minHeight: heights[0] ?? null,
    maxHeight: heights[heights.length - 1] ?? null,
    minWidth: widths[0] ?? null,
    maxWidth: widths[widths.length - 1] ?? null,
    minGap: gaps[0] ?? null,
    maxGap: gaps[gaps.length - 1] ?? null,
    negativeGapCount: gaps.filter(gap => gap < 0).length,
  }
}

function collectDomSummary() {
  return {
    shapeNodes: document.querySelectorAll('[data-shape-type]').length,
    svgPageNodes: document.querySelectorAll('[data-shape-type="svg-page"]').length,
    htmlPageNodes: document.querySelectorAll('[data-shape-type="html-page"]').length,
    iframes: document.querySelectorAll('iframe').length,
    fleetDocviews: document.querySelectorAll('.fleet-docview [data-viewport-id]').length,
  }
}

function postLivePerf(data: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    level: 'info',
    ns: 'live-perf',
    msg: 'live perf sample',
    data,
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
    // Telemetry upload is best effort; losing it must not break the viewer.
    console.warn('[live-perf] sample upload failed', err)
  }
}

function postWebVital(metric: MetricWithAttribution, context: () => Record<string, unknown>) {
  postLivePerf({
    version: LIVE_PERF_VERSION,
    source: 'web-vitals',
    metric: {
      name: metric.name,
      id: metric.id,
      value: metric.value,
      rating: metric.rating,
      delta: metric.delta,
      navigationType: metric.navigationType,
      attribution: metric.attribution,
    },
    ...context(),
  })
}

export function installLivePerfProbe(editor: Editor, documentInfo: SvgDocument, roomId: string): LivePerfProbeHandle | null {
  if (!livePerfEnabled()) return null

  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const startedAt = Date.now()
  let stopped = false

  const baseContext = () => ({
    sessionId,
    uptimeMs: Date.now() - startedAt,
    href: window.location.href,
    userAgent: navigator.userAgent,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    document: {
      name: documentInfo.name,
      format: documentInfo.format || 'svg',
      roomId,
      manifestPages: documentInfo.pages.length,
      targets: documentInfo.targets?.map(target => ({ name: target.name, pages: target.pages })) || [],
    },
  })

  const sample = (reason = 'periodic') => {
    if (stopped) return
    const records = Object.values(editor.store.allRecords()) as any[]
    const shapes = records.filter(record => record?.typeName === 'shape')
    const shapeTypes = countBy(shapes.map(shape => String(shape.type || 'unknown')))
    const camera = editor.getCamera()
    const memory = (performance as Performance & { memory?: BrowserMemory }).memory
    const payload = {
      version: LIVE_PERF_VERSION,
      source: 'tlda-live-sampler',
      reason,
      ...baseContext(),
      editor: {
        currentPageId: editor.getCurrentPageId(),
        pageCount: editor.getPages().length,
        recordCount: records.length,
        shapeCount: shapes.length,
        currentPageShapeCount: editor.getCurrentPageShapes().length,
        shapeTypes,
        camera: { x: camera.x, y: camera.y, z: camera.z },
      },
      htmlPages: summarizeHtmlPages(shapes),
      dom: collectDomSummary(),
      memory: memory ? {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
      } : undefined,
    }
    postLivePerf(payload)
  }

  const interval = window.setInterval(() => sample(), SAMPLE_INTERVAL_MS)
  window.setTimeout(() => sample('mount'), 0)
  const reportVital = (metric: MetricWithAttribution) => postWebVital(metric, baseContext)
  onCLS(reportVital, { reportAllChanges: true })
  onFCP(reportVital)
  onINP(reportVital, { reportAllChanges: true })
  onLCP(reportVital, { reportAllChanges: true })
  onTTFB(reportVital)
  const onPageHide = () => sample('pagehide')
  window.addEventListener('pagehide', onPageHide)

  const handle = {
    sample,
    stop() {
      stopped = true
      window.clearInterval(interval)
      window.removeEventListener('pagehide', onPageHide)
    },
  }
  window.__livePerfProbe = handle
  console.info('[live-perf] collecting opt-in samples')
  return handle
}
