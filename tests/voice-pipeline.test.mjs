import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVoicePipelineSnapshot } from '../server/lib/observability/voice-pipeline.mjs'

test('voice pipeline snapshot attributes existing bridge and browser facts', () => {
  const snapshot = buildVoicePipelineSnapshot({
    now: Date.parse('2026-07-18T04:00:00Z'),
    bridgeLines: [
      '2026-07-18T03:59:00Z [deepgram-sdk-bridge] browser connected (1 total)',
      '2026-07-18T03:59:10Z [deepgram-sdk-bridge] connected to Deepgram',
      '2026-07-18T03:59:20Z [deepgram-sdk-bridge] upstream closed (code 1011); not redialing — waits for audio/start (drop #1)',
      '2026-07-18T03:59:30Z [deepgram-sdk-bridge] pending audio dropped: socket not open',
      '2026-07-18T03:59:40Z [deepgram-sdk-bridge] idle cutoff — no speech for 25000ms, closing upstream',
    ],
    livePerfSamples: [{ ts: '2026-07-18T03:59:50Z', data: { voice: { backend: 'deepgram', recording: true, liveness: 'no-input', healthLabel: 'connection lost', deepgram: { connected: false, hasMicStream: true, lastMicFrameAgoMs: 120, lastAudioChunkAgoMs: 5000 } } } }],
  })

  assert.equal(snapshot.counts.browser_connects, 1)
  assert.equal(snapshot.counts.deepgram_connects, 1)
  assert.equal(snapshot.counts.deepgram_drops, 1)
  assert.equal(snapshot.counts.bridge_drops, 1)
  assert.equal(snapshot.counts.stalls, 1)
  assert.equal(snapshot.last_failure.layer, 'bridge')
  assert.equal(snapshot.latest_browser.health, 'connection lost')
  assert.equal(snapshot.source.read_only, true)
})
