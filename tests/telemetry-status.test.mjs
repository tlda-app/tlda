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
  assert.match(markdown, /\| Browser sessions \|/)
  assert.match(markdown, /No browser telemetry samples retained/)
})
