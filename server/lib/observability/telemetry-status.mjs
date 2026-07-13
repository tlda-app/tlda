const DEFAULT_RECENT_WINDOW_MS = 5 * 60 * 1000
const ATTENTION_LIMIT = 10
const AFFECTED_SAMPLE_LIMIT = 5
const EVENT_LOOP_ATTENTION_MS = 1000
const ACTIVITY_LATENCY_ATTENTION_P95_MS = 5000
const ACTIVITY_LATENCY_ATTENTION_MAX_MS = 30000

function parseTime(value) {
  const ms = Date.parse(value || '')
  return Number.isFinite(ms) ? ms : null
}

function ageMs(ts, nowMs) {
  const ms = parseTime(ts)
  return ms == null ? null : Math.max(0, nowMs - ms)
}

function ageFromMs(ms, nowMs) {
  return Number.isFinite(ms) ? Math.max(0, nowMs - ms) : null
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

function latestTimestamp(values) {
  let latest = null
  for (const value of values) {
    const ms = parseTime(value?.ts)
    if (ms == null) continue
    if (latest == null || ms > latest.ms) latest = { ms, ts: value.ts }
  }
  return latest
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

function summarizeAppShell(latest, nowMs) {
  const states = latest.map(sample => sample?.data?.appShell).filter(Boolean)
  const affectedSessions = latest
    .filter(sample => {
      const status = sample?.data?.appShell?.status
      return status === 'stale' || status === 'reload-suppressed'
    })
    .slice(0, AFFECTED_SAMPLE_LIMIT)
    .map(sample => {
      const state = sample.data.appShell
      return {
        sessionId: sample.sessionId || sample?.data?.sessionId || null,
        doc: sample.doc || sample?.data?.document?.name || null,
        href: sample?.data?.href || null,
        status: state.status,
        loadedSha: state.loadedSha || null,
        latestSha: state.latestSha || null,
        ageMs: ageMs(sample.ts, nowMs),
      }
    })
  return {
    status: states.some(state => state.status === 'stale' || state.status === 'reload-suppressed') ? 'attention'
      : states.length ? 'ok' : 'unknown',
    counts: countBy(states.map(state => state.status)),
    latestLoadedSha: states.find(state => state.loadedSha)?.loadedSha || null,
    latestLiveSha: states.find(state => state.latestSha)?.latestSha || null,
    affectedSessions,
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

function summarizeFreshness({ livePerfSamples, livePerfRetained, serverPerfEvents, serverPerfRetained, latestSessions, eventLoopLag, nowMs }) {
  const latestLivePerf = latestTimestamp(livePerfSamples)
  const latestServerPerf = latestTimestamp(serverPerfEvents)
  return {
    sourceInputs: {
      livePerf: {
        retained: livePerfRetained,
        latestSessions: latestSessions.length,
        latestAt: latestLivePerf?.ts || null,
        latestAgeMs: latestLivePerf ? ageFromMs(latestLivePerf.ms, nowMs) : null,
      },
      serverPerf: {
        retained: serverPerfRetained,
        latestAt: latestServerPerf?.ts || null,
        latestAgeMs: latestServerPerf ? ageFromMs(latestServerPerf.ms, nowMs) : null,
      },
      eventLoopLag: {
        latestAtMs: Number.isFinite(eventLoopLag?.at) ? eventLoopLag.at : null,
        latestAgeMs: ageFromMs(eventLoopLag?.at, nowMs),
      },
    },
  }
}

function statusFromLatency(activityLatency) {
  if (!activityLatency) return 'unknown'
  return Number(activityLatency.p95Ms) >= ACTIVITY_LATENCY_ATTENTION_P95_MS ||
    Number(activityLatency.maxMs) >= ACTIVITY_LATENCY_ATTENTION_MAX_MS
    ? 'attention'
    : 'ok'
}

function summarizeRoutes({ sync, fleet, activityLatency, server }) {
  return {
    browserFleetWs: {
      status: fleet.status,
      connected: fleet.connected,
      maxDisconnectedForMs: fleet.maxDisconnectedForMs,
      pendingRpcCount: fleet.pendingRpcCount,
    },
    syncWs: {
      status: sync.status,
      connectionStatus: sync.connectionStatus,
      tldrawStatus: sync.tldrawStatus,
    },
    daemonWs: {
      status: Number(server.ws?.byKind?.daemon) > 0 ? 'ok' : 'unknown',
      count: Number(server.ws?.byKind?.daemon) || 0,
      reason: Number(server.ws?.byKind?.daemon) > 0 ? null : 'no daemon websocket count in current summary',
    },
    activityLatency: {
      status: statusFromLatency(activityLatency),
      p50Ms: activityLatency?.p50Ms ?? null,
      p95Ms: activityLatency?.p95Ms ?? null,
      maxMs: activityLatency?.maxMs ?? null,
      thresholdP95Ms: ACTIVITY_LATENCY_ATTENTION_P95_MS,
      thresholdMaxMs: ACTIVITY_LATENCY_ATTENTION_MAX_MS,
    },
    subscriptionNotifications: {
      status: 'unknown',
      reason: 'no structured subscription telemetry input',
    },
  }
}

function attentionItem({ area, severity = 'warning', since = null, summary, evidence = {}, nextLookup = null }) {
  return {
    area,
    status: 'attention',
    severity,
    since,
    summary,
    evidence,
    nextLookup,
  }
}

function severityRank(severity) {
  if (severity === 'critical') return 0
  if (severity === 'warning') return 1
  return 2
}

function buildAttention({ appShell, sync, fleet, activityLatency, server, recentClientDisconnects }) {
  const items = []

  if (appShell.status === 'attention') {
    items.push(attentionItem({
      area: 'app-shell',
      severity: 'warning',
      summary: `App shell is ${fmtCountMap(appShell.counts)}`,
      evidence: {
        counts: appShell.counts,
        latestLoadedSha: appShell.latestLoadedSha,
        latestLiveSha: appShell.latestLiveSha,
        affectedSessions: appShell.affectedSessions,
      },
      nextLookup: '/api/diagnostics/telemetry-status',
    }))
  }

  if (sync.status === 'attention') {
    items.push(attentionItem({
      area: 'sync-ws',
      severity: 'warning',
      summary: `Sync connection has ${fmtCountMap(sync.connectionStatus)}`,
      evidence: sync,
      nextLookup: '/api/diagnostics/live-perf',
    }))
  }

  if (fleet.status === 'attention') {
    items.push(attentionItem({
      area: 'browser-fleet-ws',
      severity: fleet.maxDisconnectedForMs >= 30000 ? 'critical' : 'warning',
      summary: `Browser fleet WS has ${fmtCountMap(fleet.connected)}`,
      evidence: {
        connected: fleet.connected,
        maxDisconnectedForMs: fleet.maxDisconnectedForMs,
        pendingRpcCount: fleet.pendingRpcCount,
      },
      nextLookup: '/api/diagnostics/live-perf',
    }))
  }

  if (statusFromLatency(activityLatency) === 'attention') {
    items.push(attentionItem({
      area: 'activity-latency',
      severity: Number(activityLatency?.p95Ms) >= 30000 || Number(activityLatency?.maxMs) >= 120000 ? 'critical' : 'warning',
      summary: `Activity latency p95 ${fmtMs(activityLatency?.p95Ms)}, max ${fmtMs(activityLatency?.maxMs)}`,
      evidence: {
        p50Ms: activityLatency?.p50Ms ?? null,
        p95Ms: activityLatency?.p95Ms ?? null,
        maxMs: activityLatency?.maxMs ?? null,
      },
      nextLookup: '/api/diagnostics/live-perf',
    }))
  }

  if (Number(server.eventLoopLag?.maxMs) >= EVENT_LOOP_ATTENTION_MS) {
    items.push(attentionItem({
      area: 'event-loop',
      severity: Number(server.eventLoopLag?.maxMs) >= 5000 ? 'critical' : 'warning',
      since: Number.isFinite(server.eventLoopLag?.at) ? new Date(server.eventLoopLag.at).toISOString() : null,
      summary: `Event loop lag max ${fmtMs(server.eventLoopLag?.maxMs)}, mean ${fmtMs(server.eventLoopLag?.meanMs)}`,
      evidence: { eventLoopLag: server.eventLoopLag },
      nextLookup: '/api/diagnostics/live-perf',
    }))
  }

  const heartbeatTerminates = server.recentDisconnects.filter(event => event.type === 'heartbeat-terminate')
  const heartbeatSkips = server.recentDisconnects.filter(event => event.type === 'heartbeat-skip-lag')
  const serverWsCloses = server.recentDisconnects.filter(event => event.type === 'ws-close')
  if (heartbeatTerminates.length || heartbeatSkips.length || serverWsCloses.length) {
    items.push(attentionItem({
      area: 'server-ws-disconnects',
      severity: heartbeatTerminates.length ? 'critical' : 'warning',
      since: server.recentDisconnects[0]?.ts || null,
      summary: `${server.recentDisconnects.length} recent server WS disconnect/heartbeat event(s)`,
      evidence: {
        heartbeatTerminate: heartbeatTerminates.length,
        heartbeatSkipLag: heartbeatSkips.length,
        wsClose: serverWsCloses.length,
        recent: server.recentDisconnects.slice(0, AFFECTED_SAMPLE_LIMIT),
      },
      nextLookup: '/api/diagnostics/live-perf',
    }))
  }

  if (recentClientDisconnects.length) {
    items.push(attentionItem({
      area: 'browser-disconnects',
      severity: 'warning',
      since: recentClientDisconnects[0]?.ts || null,
      summary: `${recentClientDisconnects.length} recent browser disconnect lifecycle event(s)`,
      evidence: {
        recent: recentClientDisconnects.slice(0, AFFECTED_SAMPLE_LIMIT),
      },
      nextLookup: '/api/diagnostics/live-perf',
    }))
  }

  return items
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || (parseTime(b.since) || 0) - (parseTime(a.since) || 0))
    .slice(0, ATTENTION_LIMIT)
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
  const appShell = summarizeAppShell(latest, nowMs)
  const sync = summarizeSync(latest)
  const fleet = summarizeFleet(latest, ws)
  const voice = summarizeVoice(latest)
  const activityLatency = summarizeLatency(latest)
  const server = summarizeServer(serverPerfEvents, eventLoopLag, ws)
  const recentClientDisconnects = recentEvents(livePerfSamples, ['network-offline', 'pagehide'], 10)
  const freshness = summarizeFreshness({
    livePerfSamples,
    livePerfRetained,
    serverPerfEvents,
    serverPerfRetained,
    latestSessions: latest,
    eventLoopLag,
    nowMs,
  })
  const routes = summarizeRoutes({ sync, fleet, activityLatency, server })
  const attention = buildAttention({ appShell, sync, fleet, activityLatency, server, recentClientDisconnects })
  const sections = [browser, appShell, sync, fleet, voice, server, routes.activityLatency]
  const status = attention.length || sections.some(section => section.status === 'attention') ? 'attention'
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
    attention,
    freshness,
    routes,
    browser,
    appShell,
    sync,
    fleet,
    voice,
    activityLatency,
    server,
    recentClientDisconnects,
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

function attentionTable(items) {
  if (!items.length) return ['No attention items.', '']
  return [
    '| severity | area | summary | next lookup |',
    '| --- | --- | --- | --- |',
    ...items.map(item => `| ${esc(item.severity)} | ${esc(item.area)} | ${esc(item.summary)} | \`${esc(item.nextLookup || '')}\` |`),
    '',
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
    '## Attention',
    '',
    ...attentionTable(snapshot.attention || []),
    '## Routes',
    '',
    ...table([
      {
        area: 'Browser fleet WS',
        status: snapshot.routes?.browserFleetWs?.status || 'unknown',
        detail: `${fmtCountMap(snapshot.routes?.browserFleetWs?.connected)}; max disconnected ${fmtMs(snapshot.routes?.browserFleetWs?.maxDisconnectedForMs)}, pending RPC ${snapshot.routes?.browserFleetWs?.pendingRpcCount ?? 'unknown'}`,
      },
      {
        area: 'Sync WS',
        status: snapshot.routes?.syncWs?.status || 'unknown',
        detail: `connection ${fmtCountMap(snapshot.routes?.syncWs?.connectionStatus)}; tldraw ${fmtCountMap(snapshot.routes?.syncWs?.tldrawStatus)}`,
      },
      {
        area: 'Daemon WS',
        status: snapshot.routes?.daemonWs?.status || 'unknown',
        detail: `count ${snapshot.routes?.daemonWs?.count ?? 0}${snapshot.routes?.daemonWs?.reason ? `; ${snapshot.routes.daemonWs.reason}` : ''}`,
      },
      {
        area: 'Activity latency route',
        status: snapshot.routes?.activityLatency?.status || 'unknown',
        detail: `p95 ${fmtMs(snapshot.routes?.activityLatency?.p95Ms)}, max ${fmtMs(snapshot.routes?.activityLatency?.maxMs)}`,
      },
      {
        area: 'Subscription notifications',
        status: snapshot.routes?.subscriptionNotifications?.status || 'unknown',
        detail: snapshot.routes?.subscriptionNotifications?.reason || 'unknown',
      },
    ]),
    '',
    '## Areas',
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
