import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTelemetryStatusSnapshot,
  renderTelemetryStatusMarkdown,
} from '../server/lib/observability/telemetry-status.mjs'

test('telemetry status derives browser, sync, fleet, voice, and server summaries', () => {
  const now = new Date('2026-07-12T22:45:00.000Z')
  const snapshot = buildTelemetryStatusSnapshot({
    now,
    livePerfSamples: [
      {
        ts: '2026-07-12T22:44:30.000Z',
        sessionId: 'session-a',
        doc: 'telemetry-proof',
        reason: 'periodic',
        data: {
          sessionId: 'session-a',
          document: { name: 'telemetry-proof', format: 'markdown' },
          appShell: { status: 'current', loadedSha: 'abc123', latestSha: 'abc123' },
          sync: { status: 'synced-remote', connectionStatus: 'online' },
          fleet: { connected: true, disconnectedForMs: 0, pendingRpcCount: 1 },
          voice: { backend: 'deepgram', recording: true, liveness: 'live', healthLabel: 'mic live' },
          dom: {
            visibleActivityLatency: {
              summary: {
                jsonlToRender: { p50Ms: 100, p95Ms: 250, maxMs: 400 },
              },
            },
          },
          events: [
            { ts: '2026-07-12T22:44:20.000Z', type: 'network-offline', detail: { online: false } },
          ],
        },
      },
    ],
    serverPerfEvents: [
      {
        ts: '2026-07-12T22:44:40.000Z',
        type: 'ws-close',
        detail: { kind: 'sync', code: 1006 },
      },
    ],
    eventLoopLag: { maxMs: 32, meanMs: 8, at: now.getTime() },
    ws: { total: 3, byKind: { sync: 2, fleet: 1 } },
  })

  assert.equal(snapshot.schema.name, 'tlda.telemetry.status')
  assert.equal(snapshot.source.kind, 'derived-view')
  assert.equal(snapshot.freshness.sourceInputs.livePerf.latestAgeMs, 30000)
  assert.equal(snapshot.freshness.sourceInputs.serverPerf.latestAgeMs, 20000)
  assert.equal(snapshot.routes.browserFleetWs.status, 'ok')
  assert.equal(snapshot.routes.syncWs.status, 'ok')
  assert.equal(snapshot.routes.subscriptionNotifications.status, 'unknown')
  assert.equal(snapshot.browser.recentSessionCount, 1)
  assert.equal(snapshot.browser.docs['telemetry-proof'], 1)
  assert.deepEqual(snapshot.appShell.counts, { current: 1 })
  assert.deepEqual(snapshot.sync.connectionStatus, { online: 1 })
  assert.deepEqual(snapshot.fleet.connected, { connected: 1 })
  assert.equal(snapshot.fleet.pendingRpcCount, 1)
  assert.equal(snapshot.activityLatency.p50Ms, 100)
  assert.equal(snapshot.activityLatency.p95Ms, 250)
  assert.deepEqual(snapshot.voice.backend, { deepgram: 1 })
  assert.equal(snapshot.server.recentDisconnects.length, 1)
  assert.equal(snapshot.recentClientDisconnects.length, 1)
})

test('telemetry status derives bounded attention, freshness, and route health', () => {
  const now = new Date('2026-07-12T22:45:00.000Z')
  const snapshot = buildTelemetryStatusSnapshot({
    now,
    livePerfSamples: [
      {
        ts: '2026-07-12T22:44:00.000Z',
        sessionId: 'session-stale',
        doc: 'status',
        reason: 'periodic',
        data: {
          sessionId: 'session-stale',
          href: 'https://example.test/?doc=status',
          document: { name: 'status', format: 'markdown' },
          appShell: { status: 'stale', loadedSha: 'oldsha', latestSha: 'newsha' },
          sync: { status: 'synced-remote', connectionStatus: 'online' },
          fleet: { connected: false, disconnectedForMs: 35000, pendingRpcCount: 2 },
          dom: {
            visibleActivityLatency: {
              summary: {
                jsonlToRender: { p50Ms: 1200, p95Ms: 6000, maxMs: 45000 },
              },
            },
          },
          events: [
            { ts: '2026-07-12T22:43:59.000Z', type: 'pagehide', detail: { persisted: false } },
          ],
        },
      },
    ],
    serverPerfEvents: [
      {
        ts: '2026-07-12T22:44:15.000Z',
        type: 'heartbeat-terminate',
        detail: { kind: 'fleet' },
      },
      {
        ts: '2026-07-12T22:44:20.000Z',
        type: 'heartbeat-skip-lag',
        detail: { sweepDelayMs: 1500 },
      },
    ],
    eventLoopLag: { maxMs: 1500, meanMs: 75, at: Date.parse('2026-07-12T22:44:50.000Z') },
    ws: { total: 4, byKind: { fleet: 2, sync: 1, daemon: 1 } },
  })

  assert.equal(snapshot.status, 'attention')
  assert.equal(snapshot.freshness.sourceInputs.livePerf.retained, 1)
  assert.equal(snapshot.freshness.sourceInputs.livePerf.latestAgeMs, 60000)
  assert.equal(snapshot.freshness.sourceInputs.serverPerf.latestAgeMs, 40000)
  assert.equal(snapshot.freshness.sourceInputs.eventLoopLag.latestAgeMs, 10000)
  assert.equal(snapshot.routes.browserFleetWs.status, 'attention')
  assert.equal(snapshot.routes.activityLatency.status, 'attention')
  assert.equal(snapshot.routes.daemonWs.status, 'ok')
  assert.deepEqual(snapshot.routes.subscriptionNotifications, {
    status: 'unknown',
    reason: 'no structured subscription telemetry input',
  })

  const byArea = Object.fromEntries(snapshot.attention.map(item => [item.area, item]))
  assert.equal(byArea['app-shell'].severity, 'warning')
  assert.equal(byArea['app-shell'].evidence.affectedSessions[0].sessionId, 'session-stale')
  assert.equal(byArea['browser-fleet-ws'].severity, 'critical')
  assert.equal(byArea['activity-latency'].status, 'attention')
  assert.equal(byArea['event-loop'].summary, 'Event loop lag max 1500 ms, mean 75 ms')
  assert.equal(byArea['server-ws-disconnects'].severity, 'critical')
  assert.equal(byArea['browser-disconnects'].evidence.recent.length, 1)
  assert.ok(snapshot.attention.length <= 10)
})

test('telemetry status markdown is a generated view, not stored state', () => {
  const snapshot = buildTelemetryStatusSnapshot({
    now: new Date('2026-07-12T22:45:00.000Z'),
    livePerfSamples: [],
    serverPerfEvents: [],
    eventLoopLag: { maxMs: 1, meanMs: 1, at: Date.now() },
    ws: { total: 0, byKind: {} },
  })

  const markdown = renderTelemetryStatusMarkdown(snapshot)
  assert.match(markdown, /^# Telemetry status/m)
  assert.match(markdown, /generated view over structured telemetry/)
  assert.match(markdown, /## Attention/)
  assert.match(markdown, /No attention items/)
  assert.ok(markdown.indexOf('## Attention') < markdown.indexOf('| Browser sessions |'))
  assert.ok(markdown.indexOf('## Routes') < markdown.indexOf('## Areas'))
  assert.match(markdown, /\| Subscription notifications \| unknown \| no structured subscription telemetry input \|/)
  assert.match(markdown, /\| Browser sessions \|/)
  assert.match(markdown, /No browser telemetry samples retained/)
})

test('telemetry status derives UI intent transaction health', () => {
  const now = new Date('2026-07-12T22:45:00.000Z')
  const sample = {
    ts: '2026-07-12T22:44:58.000Z',
    sessionId: 'session-intent',
    doc: 'status',
    reason: 'client-event',
    data: {
      sessionId: 'session-intent',
      document: { name: 'status', format: 'markdown' },
      events: [
        {
          ts: '2026-07-12T22:44:57.000Z',
          type: 'ui-intent',
          detail: {
            intentId: 'intent-ok',
            action: 'fleet-chat-filter-drop',
            phase: 'intent-start',
            surface: 'fleet-chat-filter-overlay',
          },
        },
        {
          ts: '2026-07-12T22:44:57.050Z',
          type: 'ui-intent',
          detail: {
            intentId: 'intent-ok',
            action: 'fleet-chat-filter-drop',
            phase: 'valid-target',
            surface: 'fleet-chat-filter-overlay',
            target: { shapeId: 'shape:chat-a', type: 'fleet-chat' },
            preview: { role: 'to', filterHash: 'hash-a' },
          },
        },
        {
          ts: '2026-07-12T22:44:57.100Z',
          type: 'ui-intent',
          detail: {
            intentId: 'intent-ok',
            action: 'fleet-chat-filter-drop',
            phase: 'drop',
            surface: 'fleet-chat-filter-overlay',
          },
        },
        {
          ts: '2026-07-12T22:44:57.120Z',
          type: 'ui-intent',
          detail: {
            intentId: 'intent-ok',
            action: 'fleet-chat-filter-drop',
            phase: 'mutation-request',
            surface: 'fleet-chat-filter-overlay',
            stateHashBefore: 'hash-before',
          },
        },
        {
          ts: '2026-07-12T22:44:57.150Z',
          type: 'ui-intent',
          detail: {
            intentId: 'intent-ok',
            action: 'fleet-chat-filter-drop',
            phase: 'mutation-commit',
            surface: 'fleet-chat-filter-overlay',
            stateHashAfter: 'hash-a',
          },
        },
        {
          ts: '2026-07-12T22:44:57.180Z',
          type: 'ui-intent',
          detail: {
            intentId: 'intent-ok',
            action: 'fleet-chat-filter-drop',
            phase: 'render-confirmed',
            surface: 'fleet-chat-filter-overlay',
            renderCheck: 'fleet-chat.props.filter',
          },
        },
      ],
    },
  }

  const snapshot = buildTelemetryStatusSnapshot({
    now,
    livePerfSamples: [sample],
    serverPerfEvents: [],
    eventLoopLag: { maxMs: 1, meanMs: 1, at: now.getTime() },
    ws: { total: 1, byKind: { daemon: 1 } },
  })

  assert.equal(snapshot.uiIntentTransactions.status, 'ok')
  assert.equal(snapshot.uiIntentTransactions.retained, 1)
  assert.equal(snapshot.routes.uiIntentTransactions.status, 'ok')
  assert.equal(snapshot.uiIntentTransactions.recent[0].lastPhase, 'render-confirmed')
  assert.deepEqual(snapshot.uiIntentTransactions.recent[0].phases, [
    'intent-start',
    'valid-target',
    'drop',
    'mutation-request',
    'mutation-commit',
    'render-confirmed',
  ])
})

test('telemetry status flags recognized UI intent without commit', () => {
  const now = new Date('2026-07-12T22:45:00.000Z')
  const snapshot = buildTelemetryStatusSnapshot({
    now,
    livePerfSamples: [
      {
        ts: '2026-07-12T22:44:58.000Z',
        sessionId: 'session-intent',
        doc: 'status',
        reason: 'client-event',
        data: {
          sessionId: 'session-intent',
          document: { name: 'status', format: 'markdown' },
          events: [
            {
              ts: '2026-07-12T22:44:57.000Z',
              type: 'ui-intent',
              detail: {
                intentId: 'intent-stalled',
                action: 'fleet-chat-filter-drop',
                phase: 'valid-target',
                surface: 'fleet-chat-filter-overlay',
                target: { shapeId: 'shape:chat-a', type: 'fleet-chat' },
                preview: { role: 'to', filterHash: 'hash-a' },
              },
            },
            {
              ts: '2026-07-12T22:44:57.050Z',
              type: 'ui-intent',
              detail: {
                intentId: 'intent-stalled',
                action: 'fleet-chat-filter-drop',
                phase: 'drop',
                surface: 'fleet-chat-filter-overlay',
                target: { shapeId: 'shape:chat-a', type: 'fleet-chat' },
              },
            },
          ],
        },
      },
    ],
    serverPerfEvents: [],
    eventLoopLag: { maxMs: 1, meanMs: 1, at: now.getTime() },
    ws: { total: 1, byKind: { daemon: 1 } },
  })

  assert.equal(snapshot.status, 'attention')
  assert.equal(snapshot.uiIntentTransactions.status, 'attention')
  assert.equal(snapshot.uiIntentTransactions.attentionCount, 1)
  assert.equal(snapshot.uiIntentTransactions.attention[0].reason, 'no-mutation-commit')
  const item = snapshot.attention.find(entry => entry.area === 'intent-transactions')
  assert.ok(item)
  assert.match(item.summary, /fleet-chat-filter-drop recognized target/)
  assert.equal(item.evidence.intentId, 'intent-stalled')
  assert.equal(item.nextLookup, '/api/diagnostics/live-perf')
})

test('telemetry status markdown includes UI intent route and area rows', () => {
  const snapshot = buildTelemetryStatusSnapshot({
    now: new Date('2026-07-12T22:45:00.000Z'),
    livePerfSamples: [],
    serverPerfEvents: [],
    eventLoopLag: { maxMs: 1, meanMs: 1, at: Date.parse('2026-07-12T22:45:00.000Z') },
    ws: { total: 0, byKind: {} },
  })

  const markdown = renderTelemetryStatusMarkdown(snapshot)
  assert.match(markdown, /\| UI intent transactions \| unknown \| 0 retained; 0 attention; no structured UI intent telemetry retained \|/)
  assert.match(markdown, /\| Intent transactions \| unknown \| 0 retained; 0 attention \|/)
})
