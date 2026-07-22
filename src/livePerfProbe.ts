import type { Editor } from 'tldraw'
import type { SvgDocument } from './svgDocumentLoader'
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals/attribution'
import type { MetricWithAttribution } from 'web-vitals/attribution'
import { getFleetRuntimeSummary } from './fleet/fleet-data.mjs'
import { getVoiceRuntimeSummary } from './voice.mjs'
import { getAppShellFreshnessSummary } from './appShellFreshness'
import { postLivePerf } from './livePerfUpload'

type LivePerfProbeHandle = {
  recordEvent: (type: string, detail?: Record<string, unknown>) => void
  sample: (reason?: string) => void
  stop: () => void
}

type BrowserMemory = {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

type LivePerfProbeOptions = {
  getSyncStatus?: () => Record<string, unknown>
}

type LivePerfEvent = {
  ts: string
  t: number
  type: string
  detail?: Record<string, unknown>
}

type ShapeRecordLike = {
  typeName?: string
  type?: string
  parentId?: string
  x?: number
  y?: number
  props?: {
    filter?: unknown
    h?: number
    trafficMode?: string
    w?: number
  }
}

declare global {
  interface Window {
    __livePerfProbe?: LivePerfProbeHandle
  }
}

const SAMPLE_INTERVAL_MS = 10_000
const LIVE_PERF_VERSION = 1
const MAX_EVENT_BUFFER = 80
const MAX_LONGTASK_EVENTS = 60

function livePerfEnabled() {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  const urlPerf = params.get('perf') || ''
  let storedPerf = ''
  try { storedPerf = localStorage.getItem('tlda-perf') || '' } catch { storedPerf = '' }
  const values = [urlPerf, storedPerf]
  if (values.some(value => value === '0' || value === 'false' || value.split(',').map(v => v.trim()).includes('off'))) return false
  return true
}

function countBy<T extends string>(values: T[]) {
  const out: Record<string, number> = {}
  for (const value of values) out[value] = (out[value] || 0) + 1
  return out
}

function summarizeHtmlPages(shapes: ShapeRecordLike[]) {
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

function finiteMs(value: string | undefined) {
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function isoMs(value: string | undefined) {
  if (!value) return null
  const n = Date.parse(value)
  return Number.isFinite(n) ? n : null
}

function deltaMs(later: number | null, earlier: number | null) {
  return later != null && earlier != null ? Math.max(0, later - earlier) : null
}

function summarizeLatencyValues(values: Array<number | null>) {
  const sorted = values.filter((value): value is number => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
  return {
    count: sorted.length,
    minMs: sorted[0],
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    maxMs: sorted[sorted.length - 1],
  }
}

function collectVisibleActivityLatency() {
  const cards = Array.from(document.querySelectorAll<HTMLElement>('.chat-activity-card, [data-activity-card]'))
    .slice(-40)
    .map(card => {
      const jsonlMs = isoMs(card.dataset.jsonlTs || card.dataset.ts)
      const daemonReceivedMs = finiteMs(card.dataset.daemonReceivedAtMs)
      const daemonSentMs = finiteMs(card.dataset.daemonSentAtMs)
      const serverReceivedMs = finiteMs(card.dataset.serverReceivedAtMs)
      const serverBroadcastQueuedMs = finiteMs(card.dataset.serverBroadcastQueuedAtMs)
      const browserReceivedMs = finiteMs(card.dataset.browserReceivedAtMs)
      const browserRenderQueuedMs = finiteMs(card.dataset.browserRenderQueuedAtMs)
      const browserMountedMs = finiteMs(card.dataset.browserMountedAtMs)
      const renderedMs = browserMountedMs || browserRenderQueuedMs
      return {
        id: card.dataset.msgId || null,
        agent: card.dataset.agent || null,
        jsonlTs: card.dataset.jsonlTs || card.dataset.ts || null,
        jsonlToDaemonMs: deltaMs(daemonReceivedMs || daemonSentMs, jsonlMs),
        daemonQueueMs: deltaMs(daemonSentMs, daemonReceivedMs),
        daemonToServerMs: deltaMs(serverReceivedMs, daemonSentMs),
        serverToBrowserMs: deltaMs(browserReceivedMs, serverBroadcastQueuedMs || serverReceivedMs),
        browserToRenderMs: deltaMs(renderedMs, browserReceivedMs),
        jsonlToRenderMs: deltaMs(renderedMs, jsonlMs),
      }
    })
  return {
    count: cards.length,
    recent: cards.slice(-12),
    summary: {
      jsonlToDaemon: summarizeLatencyValues(cards.map(card => card.jsonlToDaemonMs)),
      daemonQueue: summarizeLatencyValues(cards.map(card => card.daemonQueueMs)),
      daemonToServer: summarizeLatencyValues(cards.map(card => card.daemonToServerMs)),
      serverToBrowser: summarizeLatencyValues(cards.map(card => card.serverToBrowserMs)),
      browserToRender: summarizeLatencyValues(cards.map(card => card.browserToRenderMs)),
      jsonlToRender: summarizeLatencyValues(cards.map(card => card.jsonlToRenderMs)),
    },
  }
}

function summarizeFleetChatShapes(shapes: ShapeRecordLike[]) {
  const chatShapes = shapes.filter(shape => shape?.typeName === 'shape' && shape?.type === 'fleet-chat')
  const trafficModes = countBy(chatShapes.map(shape => String(shape.props?.trafficMode || 'normal')))
  const filterKinds = countBy(chatShapes.map(shape => {
    const filter = shape.props?.filter
    if (!Array.isArray(filter) || filter.length === 0) return 'all'
    if (filter.some((clause: unknown) =>
      Array.isArray(clause) && clause.some((term: unknown) => Array.isArray(term) && term[0] === 'dm')
    )) return 'dm'
    return 'custom'
  }))
  return {
    count: chatShapes.length,
    trafficModes,
    filterKinds,
    filteredCount: chatShapes.filter(shape => Array.isArray(shape.props?.filter) && shape.props.filter.length > 0).length,
  }
}

function isShapeRecordLike(record: unknown): record is ShapeRecordLike {
  return !!record && typeof record === 'object' && (record as { typeName?: unknown }).typeName === 'shape'
}

function collectDomSummary() {
  return {
    shapeNodes: document.querySelectorAll('[data-shape-type]').length,
    svgPageNodes: document.querySelectorAll('[data-shape-type="svg-page"]').length,
    htmlPageNodes: document.querySelectorAll('[data-shape-type="html-page"]').length,
    iframes: document.querySelectorAll('iframe').length,
    fleetDocviews: document.querySelectorAll('.fleet-docview [data-viewport-id]').length,
    fleetShapes: document.querySelectorAll('.fleet-chat-shape, .fleet-inbox-shape, .fleet-agents-shape, .fleet-status-shape').length,
    fleetChatShapes: document.querySelectorAll('.fleet-chat-shape').length,
    fleetInboxShapes: document.querySelectorAll('.fleet-inbox-shape').length,
    fleetAgentRows: document.querySelectorAll('.fleet-agents-row, .fleet-phone-agent').length,
    fleetChatLines: document.querySelectorAll('.fleet-chat-shape .chat-line, .fleet-chat-shape [data-chat-line]').length,
    fleetActivityCards: document.querySelectorAll('.chat-activity-card, .activity-card, .fleet-activity-card, [data-activity-card]').length,
    visibleActivityLatency: collectVisibleActivityLatency(),
    textareas: document.querySelectorAll('textarea').length,
  }
}

function safeCollect<T>(fn: () => T): T | { error: string } {
  try {
    return fn()
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
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

function collectNavigationTiming() {
  const nav = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined
  if (!nav) return null
  return {
    type: nav.type,
    startTime: nav.startTime,
    domInteractive: nav.domInteractive,
    domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
    loadEventEnd: nav.loadEventEnd,
    responseStart: nav.responseStart,
    responseEnd: nav.responseEnd,
    transferSize: nav.transferSize,
    encodedBodySize: nav.encodedBodySize,
    decodedBodySize: nav.decodedBodySize,
  }
}

export function installLivePerfProbe(
  editor: Editor,
  documentInfo: SvgDocument,
  roomId: string,
  options: LivePerfProbeOptions = {},
): LivePerfProbeHandle | null {
  if (!livePerfEnabled()) return null

  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const startedAt = Date.now()
  let stopped = false
  let longTaskEventCount = 0
  let lastSyncStatusJson = ''
  const events: LivePerfEvent[] = []

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
    network: {
      online: navigator.onLine,
    },
    appShell: safeCollect(getAppShellFreshnessSummary),
  })

  const pushEvent = (event: LivePerfEvent) => {
    events.push(event)
    if (events.length > MAX_EVENT_BUFFER) events.splice(0, events.length - MAX_EVENT_BUFFER)
  }

  const recordEvent = (type: string, detail?: Record<string, unknown>) => {
    if (stopped) return
    const event = {
      ts: new Date().toISOString(),
      t: performance.now(),
      type,
      detail,
    }
    pushEvent(event)
    postLivePerf({
      version: LIVE_PERF_VERSION,
      source: 'client-event',
      event,
      events: [...events],
      ...baseContext(),
      page: {
        visibilityState: document.visibilityState,
        hidden: document.hidden,
        focused: document.hasFocus(),
        readyState: document.readyState,
      },
      sync: options.getSyncStatus ? safeCollect(options.getSyncStatus) : undefined,
      voice: safeCollect(() => getVoiceRuntimeSummary(Date.now())),
    })
  }

  const sample = (reason = 'periodic') => {
    if (stopped) return
    const now = Date.now()
    const records = Object.values(editor.store.allRecords()) as unknown[]
    const shapes = records.filter(isShapeRecordLike)
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
      fleetChatShapes: summarizeFleetChatShapes(shapes),
      dom: collectDomSummary(),
      page: {
        visibilityState: document.visibilityState,
        hidden: document.hidden,
        focused: document.hasFocus(),
        readyState: document.readyState,
      },
      navigation: collectNavigationTiming(),
      events: [...events],
      sync: options.getSyncStatus ? safeCollect(options.getSyncStatus) : undefined,
      fleet: safeCollect(() => getFleetRuntimeSummary(now)),
      voice: safeCollect(() => getVoiceRuntimeSummary(now)),
      memory: memory ? {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
      } : undefined,
    }
    postLivePerf(payload)
  }

  const interval = window.setInterval(() => sample(), SAMPLE_INTERVAL_MS)
  const syncStatusInterval = window.setInterval(() => {
    if (!options.getSyncStatus || stopped) return
    const status = safeCollect(options.getSyncStatus)
    const json = JSON.stringify(status)
    if (json === lastSyncStatusJson) return
    lastSyncStatusJson = json
    recordEvent('sync-status', { status })
  }, 1000)
  window.setTimeout(() => sample('mount'), 0)
  window.setTimeout(() => recordEvent('probe-start', {
    readyState: document.readyState,
    navigation: collectNavigationTiming(),
  }), 0)
  const reportVital = (metric: MetricWithAttribution) => postWebVital(metric, baseContext)
  onCLS(reportVital, { reportAllChanges: true })
  onFCP(reportVital)
  onINP(reportVital, { reportAllChanges: true })
  onLCP(reportVital, { reportAllChanges: true })
  onTTFB(reportVital)
  const onOnline = () => recordEvent('network-online', { online: navigator.onLine })
  const onOffline = () => recordEvent('network-offline', { online: navigator.onLine })
  const onVisibilityChange = () => recordEvent('visibilitychange', {
    visibilityState: document.visibilityState,
    hidden: document.hidden,
  })
  const onLoad = () => recordEvent('window-load', { navigation: collectNavigationTiming() })
  const onPageShow = (ev: PageTransitionEvent) => recordEvent('pageshow', { persisted: ev.persisted })
  const onPageHide = (ev?: PageTransitionEvent) => {
    recordEvent('pagehide', { persisted: ev?.persisted })
    sample('pagehide')
  }
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('load', onLoad)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('pagehide', onPageHide)
  let longTaskObserver: PerformanceObserver | null = null
  try {
    longTaskObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (longTaskEventCount >= MAX_LONGTASK_EVENTS) return
        longTaskEventCount += 1
        recordEvent('main-thread-longtask', {
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
        })
      }
    })
    longTaskObserver.observe({ entryTypes: ['longtask'] })
  } catch {
    longTaskObserver = null
  }

  const handle = {
    recordEvent,
    sample,
    stop() {
      stopped = true
      window.clearInterval(interval)
      window.clearInterval(syncStatusInterval)
      longTaskObserver?.disconnect()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('load', onLoad)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('pagehide', onPageHide)
    },
  }
  window.__livePerfProbe = handle
  console.info('[live-perf] collecting opt-in samples')
  return handle
}
