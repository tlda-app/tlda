import { randomUUID } from 'node:crypto'

const DEFAULT_MAX_EVENTS = 2000
const DEFAULT_MAX_TRACES = 500

export function createTraceId(prefix = 'cp') {
  return `${prefix}:${randomUUID()}`
}

export function compactTraceDetail(detail = {}) {
  const out = {}
  for (const [key, value] of Object.entries(detail || {})) {
    if (value !== undefined && value !== null && value !== '') out[key] = value
  }
  return out
}

export function traceIdFromMetadata(value) {
  if (!value || typeof value !== 'object') return null
  return value.trace_id || value.control_plane_trace_id || null
}

export function traceIdFromFleetEvent(event) {
  if (!event || typeof event !== 'object') return null
  return event.trace_id || traceIdFromMetadata(event.metadata)
}

function eventTime(event) {
  const raw = event?.ts || event?.timestamp
  const parsed = raw ? Date.parse(raw) : NaN
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function traceTime(trace) {
  const raw = trace?.updated_at || trace?.started_at
  const parsed = raw ? Date.parse(raw) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function trimArray(arr, max) {
  if (arr.length > max) arr.splice(0, arr.length - max)
}

export function createControlPlaneTraceStore({ maxEvents = DEFAULT_MAX_EVENTS, maxTraces = DEFAULT_MAX_TRACES } = {}) {
  const traces = new Map()
  const ordered = []

  function ensureTrace(traceId) {
    let trace = traces.get(traceId)
    if (!trace) {
      trace = { trace_id: traceId, started_at: null, updated_at: null, events: [] }
      traces.set(traceId, trace)
    }
    return trace
  }

  function trim() {
    trimArray(ordered, maxEvents)
    const retained = new Set(ordered.map(event => event.trace_id))
    for (const traceId of [...traces.keys()]) {
      if (!retained.has(traceId)) traces.delete(traceId)
    }
    while (traces.size > maxTraces) {
      let oldestId = null
      let oldestTime = Infinity
      for (const [traceId, trace] of traces.entries()) {
        const t = Date.parse(trace.updated_at || trace.started_at || '') || 0
        if (t < oldestTime) {
          oldestId = traceId
          oldestTime = t
        }
      }
      if (!oldestId) break
      traces.delete(oldestId)
      for (let i = ordered.length - 1; i >= 0; i -= 1) {
        if (ordered[i].trace_id === oldestId) ordered.splice(i, 1)
      }
    }
  }

  function append(input) {
    const traceId = input?.trace_id || input?.traceId || traceIdFromFleetEvent(input?.event)
    if (!traceId) return null
    const ts = input.ts || input.timestamp || new Date().toISOString()
    const event = {
      trace_id: traceId,
      ts,
      component: input.component || 'server',
      operation: input.operation || 'unknown',
      status: input.status || 'ok',
      ...('duration_ms' in input ? { duration_ms: input.duration_ms } : {}),
      detail: compactTraceDetail(input.detail || {}),
      ...(input.error ? { error: String(input.error) } : {}),
    }
    const trace = ensureTrace(traceId)
    if (!trace.started_at) trace.started_at = ts
    trace.updated_at = ts
    trace.events.push(event)
    ordered.push(event)
    trim()
    return event
  }

  function get(traceId) {
    const trace = traces.get(traceId)
    if (!trace) return null
    return { ...trace, events: [...trace.events] }
  }

  function recent(limit = 50) {
    const n = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(250, Math.trunc(Number(limit)))) : 50
    return [...traces.values()]
      .sort((a, b) => traceTime(b) - traceTime(a))
      .slice(0, n)
      .map(trace => ({
        trace_id: trace.trace_id,
        started_at: trace.started_at,
        updated_at: trace.updated_at,
        event_count: trace.events.length,
        last: trace.events[trace.events.length - 1] || null,
      }))
  }

  function snapshot({ traceId = null, limit = 50 } = {}) {
    if (traceId) {
      const trace = get(traceId)
      return {
        ok: true,
        trace_id: traceId,
        trace,
        retained_events: ordered.length,
        retained_traces: traces.size,
      }
    }
    return {
      ok: true,
      traces: recent(limit),
      retained_events: ordered.length,
      retained_traces: traces.size,
    }
  }

  return { append, get, recent, snapshot }
}

function markdownEscape(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function detailSummary(detail = {}) {
  const entries = Object.entries(detail || {})
  if (!entries.length) return ''
  return entries.map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`).join(' ')
}

export function renderControlPlaneTraceMarkdown(snapshot) {
  const lines = ['# Control-plane traces', '']
  if (snapshot.trace_id) {
    if (!snapshot.trace) {
      lines.push(`No trace found for \`${snapshot.trace_id}\`.`)
      return `${lines.join('\n')}\n`
    }
    const trace = snapshot.trace
    lines.push(`Trace: \`${trace.trace_id}\``)
    lines.push(`Started: ${trace.started_at || 'unknown'}`)
    lines.push(`Updated: ${trace.updated_at || 'unknown'}`)
    lines.push('')
    lines.push('| time | component | operation | status | detail |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const event of trace.events) {
      lines.push(`| ${markdownEscape(event.ts)} | ${markdownEscape(event.component)} | ${markdownEscape(event.operation)} | ${markdownEscape(event.status)} | ${markdownEscape(detailSummary(event.detail))}${event.error ? ` error=${markdownEscape(event.error)}` : ''} |`)
    }
    return `${lines.join('\n')}\n`
  }

  lines.push(`Retained traces: ${snapshot.retained_traces || 0}`)
  lines.push(`Retained events: ${snapshot.retained_events || 0}`)
  lines.push('')
  lines.push('| updated | trace | events | last hop | status |')
  lines.push('| --- | --- | ---: | --- | --- |')
  for (const trace of snapshot.traces || []) {
    const last = trace.last || {}
    lines.push(`| ${markdownEscape(trace.updated_at)} | \`${markdownEscape(trace.trace_id)}\` | ${trace.event_count} | ${markdownEscape(`${last.component || ''}.${last.operation || ''}`)} | ${markdownEscape(last.status || '')} |`)
  }
  return `${lines.join('\n')}\n`
}
