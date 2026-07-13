const DEFAULT_RECENT_WINDOW_MS = 5 * 60 * 1000

function parseTime(value) {
  const ms = Date.parse(value || '')
  return Number.isFinite(ms) ? ms : null
}

function ageMs(ts, nowMs) {
  const ms = parseTime(ts)
  return ms == null ? null : Math.max(0, nowMs - ms)
}

function compact(value) {
  if (!value || typeof value !== 'object') return null
  return value
}

function statusLabel(ok, stale) {
  if (stale) return 'stale'
  return ok ? 'ok' : 'attention'
}

function countBy(values) {
  const out = {}
  for (const value of values) {
    const key = value == null || value === '' ? 'unknown' : String(value)
    out[key] = (out[key] || 0) + 1
  }
  return out
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
}

function summarizeLatency(samples) {
  const values = {
    p50Ms: [],
    p95Ms: [],
    maxMs: [],
  }
  for (const sample of samples) {
    const summary = sample?.data?.dom?.visibleActivityLatency?.summary?.jsonlToRender
    if (Number.isFinite(summary?.p50Ms)) values.p50Ms.push(summary.p50Ms)
    if (Number.isFinite(summary?.p95Ms)) values.p95Ms.push(summary.p95Ms)
    if (Number.isFinite(summary?.maxMs)) values.maxMs.push(summary.maxMs)
  }
  if (!values.p50Ms.length && !values.p95Ms.length && !values.maxMs.length) return null
  return {
    p50Ms: percentile(values.p50Ms, 0.5),
    p95Ms: percentile(values.p95Ms, 0.95),
    maxMs: percentile(values.maxMs, 1),
  }
}

function latestSamplesBySession(samples) {
  const bySession = new Map()
  for (const sample of samples) {
    const sessionId = sample?.sessionId || sample?.data?.sessionId || 'unknown'
    const prev = bySession.get(sessionId)
    if (!prev || (parseTime(sample.ts) || 0) >= (parseTime(prev.ts) || 0)) bySession.set(sessionId, sample)
  }
  return [...bySession.values()].sort((a, b) => (parseTime(b.ts) || 0) - (parseTime(a.ts) || 0))
}

function recentEvents(samples, types, limit = 10) {
  const wanted = new Set(types)
  const events = []
  for (const sample of samples) {
    for (const event of sample?.data?.events || []) {
      if (!wanted.has(event?.type)) continue
      events.push({
        ts: event.ts || sample.ts,
        doc: sample.doc || sample?.data?.document?.name || null,
        sessionId: sample.sessionId || sample?.data?.sessionId || null,
        type: event.type,
        detail: compact(event.detail),
      })
    }
  }
  return events
    .sort((a, b) => (parseTime(b.ts) || 0) - (parseTime(a.ts) || 0))
    .slice(0, limit)
}

function activeRecentSessions(latest, nowMs, recentWindowMs) {
  return latest.filter(sample => {
    const sampleAge = ageMs(sample.ts, nowMs)
    return sampleAge != null && sampleAge <= recentWindowMs
  })
}

function summarizeBrowser(latest, nowMs, recentWindowMs) {
  if (!latest.length) {
    return {
      status: 'unknown',
      sessionCount: 0,
      recentSessionCount: 0,
      docs: {},
      latest: [],
    }
  }
  const recent = activeRecentSessions(latest, nowMs, recentWindowMs)
  return {
    status: statusLabel(recent.length > 0, latest.length > 0 && recent.length === 0),
    sessionCount: latest.length,
    recentSessionCount: recent.length,
    docs: countBy(latest.map(sample => sample.doc || sample?.data?.document?.name)),
    latest: latest.slice(0, 8).map(sample => ({
      sessionId: sample.sessionId || sample?.data?.sessionId || null,
      doc: sample.doc || sample?.data?.document?.name || null,
      format: sample?.data?.document?.format || null,
      ageMs: ageMs(sample.ts, nowMs),
      reason: sample.reason || sample?.data?.reason || null,
      href: sample?.data?.href || null,
    })),
  }
}

function summarizeAppShell(latest) {
  const states = latest.map(sample => sample?.data?.appShell).filter(Boolean)
  return {
    status: states.some(state => state.status === 'stale' || state.status === 'reload-suppressed') ? 'attention'
      : states.length ? 'ok' : 'unknown',
    counts: countBy(states.map(state => state.status)),
    latestLoadedSha: states.find(state => state.loadedSha)?.loadedSha || null,
    latestLiveSha: states.find(state => state.latestSha)?.latestSha || null,
  }
}

function summarizeSync(latest) {
  const sync = latest.map(sample => sample?.data?.sync).filter(Boolean)
  return {
    status: sync.some(state => state.connectionStatus === 'offline' || state.status === 'error') ? 'attention'
      : sync.length ? 'ok' : 'unknown',
    tldrawStatus: countBy(sync.map(state => state.status)),
    connectionStatus: countBy(sync.map(state => state.connectionStatus)),
  }
}

function summarizeFleet(latest, serverWs) {
  const fleet = latest.map(sample => sample?.data?.fleet).filter(Boolean)
  return {
    status: fleet.some(state => state.connected === false) ? 'attention' : fleet.length ? 'ok' : 'unknown',
    connected: countBy(fleet.map(state => state.connected === true ? 'connected' : state.connected === false ? 'disconnected' : 'unknown')),
    maxDisconnectedForMs: Math.max(0, ...fleet.map(state => Number(state.disconnectedForMs)).filter(Number.isFinite)),
    pendingRpcCount: fleet.reduce((sum, state) => sum + (Number(state.pendingRpcCount) || 0), 0),
    serverWs: serverWs || null,
  }
}

function summarizeVoice(latest) {
  const voice = latest.map(sample => sample?.data?.voice).filter(Boolean)
  return {
    status: voice.some(state => state.recording && (state.healthLabel === 'connection lost' || state.liveness === 'no-input')) ? 'attention'
      : voice.length ? 'ok' : 'unknown',
    backend: countBy(voice.map(state => state.backend || 'off')),
    recording: countBy(voice.map(state => state.recording ? 'recording' : 'off')),
    liveness: countBy(voice.map(state => state.liveness || 'unknown')),
    health: countBy(voice.map(state => state.healthLabel || 'quiet')),
  }
}

function summarizeServer(serverPerfEvents, eventLoopLag, ws) {
  const recentDisconnects = serverPerfEvents
    .filter(event => event.type === 'ws-close' || event.type === 'heartbeat-terminate' || event.type === 'heartbeat-skip-lag')
    .slice(-10)
    .reverse()
  return {
    status: Number(eventLoopLag?.maxMs) >= 1000 || recentDisconnects.some(event => event.type === 'heartbeat-terminate') ? 'attention' : 'ok',
    eventLoopLag: eventLoopLag || null,
    ws: ws || null,
    recentDisconnects,
    eventCounts: countBy(serverPerfEvents.map(event => event.type)),
  }
}

export function buildTelemetryStatusSnapshot({
  livePerfSamples = [],
  livePerfRetained = livePerfSamples.length,
  serverPerfEvents = [],
  serverPerfRetained = serverPerfEvents.length,
  eventLoopLag = null,
  ws = null,
  now = new Date(),
  recentWindowMs = DEFAULT_RECENT_WINDOW_MS,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  const latest = latestSamplesBySession(livePerfSamples)
  const browser = summarizeBrowser(latest, nowMs, recentWindowMs)
  const server = summarizeServer(serverPerfEvents, eventLoopLag, ws)
  const sections = [browser, server]
  const status = sections.some(section => section.status === 'attention') ? 'attention'
    : sections.some(section => section.status === 'stale') ? 'stale'
      : sections.some(section => section.status === 'unknown') ? 'unknown'
        : 'ok'
  return {
    ok: true,
    schema: {
      name: 'tlda.telemetry.status',
      version: 1,
      compatibility: 'otel-shaped-derived-view',
    },
    generatedAt: new Date(nowMs).toISOString(),
    status,
    source: {
      kind: 'derived-view',
      inputs: {
        livePerf: { retained: livePerfRetained, latestSessions: latest.length },
        serverPerf: { retained: serverPerfRetained },
      },
    },
    browser,
    appShell: summarizeAppShell(latest),
    sync: summarizeSync(latest),
    fleet: summarizeFleet(latest, ws),
    voice: summarizeVoice(latest),
    activityLatency: summarizeLatency(latest),
    server,
    recentClientDisconnects: recentEvents(livePerfSamples, ['network-offline', 'pagehide'], 10),
  }
}

function esc(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function fmtMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)} ms` : 'unknown'
}

function fmtCountMap(map) {
  const entries = Object.entries(map || {})
  return entries.length ? entries.map(([key, value]) => `${key}: ${value}`).join(', ') : 'unknown'
}

function table(rows) {
  return [
    '| area | status | detail |',
    '| --- | --- | --- |',
    ...rows.map(row => `| ${esc(row.area)} | ${esc(row.status)} | ${esc(row.detail)} |`),
  ]
}

export function renderTelemetryStatusMarkdown(snapshot) {
  const lines = [
    '# Telemetry status',
    '',
    `Generated: ${snapshot.generatedAt}`,
    `Overall: ${snapshot.status}`,
    '',
    'This is a generated view over structured telemetry. The source data remains the live performance samples and server performance events exposed by `/api/diagnostics/live-perf`.',
    '',
    ...table([
      {
        area: 'Browser sessions',
        status: snapshot.browser.status,
        detail: `${snapshot.browser.recentSessionCount} recent / ${snapshot.browser.sessionCount} retained sessions; docs ${fmtCountMap(snapshot.browser.docs)}`,
      },
      {
        area: 'App shell',
        status: snapshot.appShell.status,
        detail: `${fmtCountMap(snapshot.appShell.counts)}; loaded ${snapshot.appShell.latestLoadedSha || 'unknown'} live ${snapshot.appShell.latestLiveSha || 'unknown'}`,
      },
      {
        area: 'Sync',
        status: snapshot.sync.status,
        detail: `tldraw ${fmtCountMap(snapshot.sync.tldrawStatus)}; connection ${fmtCountMap(snapshot.sync.connectionStatus)}`,
      },
      {
        area: 'Fleet WS',
        status: snapshot.fleet.status,
        detail: `${fmtCountMap(snapshot.fleet.connected)}; server ws ${fmtCountMap(snapshot.fleet.serverWs?.byKind)}`,
      },
      {
        area: 'Event loop',
        status: snapshot.server.status,
        detail: `max ${fmtMs(snapshot.server.eventLoopLag?.maxMs)}, mean ${fmtMs(snapshot.server.eventLoopLag?.meanMs)}`,
      },
      {
        area: 'Activity latency',
        status: snapshot.activityLatency ? 'ok' : 'unknown',
        detail: snapshot.activityLatency
          ? `p50 ${fmtMs(snapshot.activityLatency.p50Ms)}, p95 ${fmtMs(snapshot.activityLatency.p95Ms)}, max ${fmtMs(snapshot.activityLatency.maxMs)}`
          : 'no visible activity latency samples',
      },
      {
        area: 'Voice',
        status: snapshot.voice.status,
        detail: `backend ${fmtCountMap(snapshot.voice.backend)}; recording ${fmtCountMap(snapshot.voice.recording)}; liveness ${fmtCountMap(snapshot.voice.liveness)}`,
      },
      {
        area: 'Recent disconnects',
        status: snapshot.server.recentDisconnects.length || snapshot.recentClientDisconnects.length ? 'attention' : 'ok',
        detail: `${snapshot.server.recentDisconnects.length} server, ${snapshot.recentClientDisconnects.length} browser`,
      },
    ]),
    '',
    '## Recent browser sessions',
    '',
  ]
  if (!snapshot.browser.latest.length) {
    lines.push('No browser telemetry samples retained.', '')
  } else {
    lines.push('| doc | session | age | reason |')
    lines.push('| --- | --- | ---: | --- |')
    for (const session of snapshot.browser.latest) {
      lines.push(`| ${esc(session.doc || 'unknown')} | \`${esc(session.sessionId || 'unknown')}\` | ${esc(fmtMs(session.ageMs))} | ${esc(session.reason || '')} |`)
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}
