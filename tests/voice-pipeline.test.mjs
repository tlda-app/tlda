import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVoicePipelineSnapshot } from '../server/lib/observability/voice-pipeline.mjs'

test('voice pipeline snapshot projects structured browser health only', () => {
  const snapshot = buildVoicePipelineSnapshot({
    now: Date.parse('2026-07-18T04:00:00Z'),
    livePerfSamples: [{ ts: '2026-07-18T03:59:50Z', data: { voice: { backend: 'deepgram', recording: true, liveness: 'no-input', healthLabel: 'connection lost', deepgram: { connected: false, hasMicStream: true, lastMicFrameAgoMs: 120, lastAudioChunkAgoMs: 5000 } } } }],
  })

  assert.equal(snapshot.latest_browser.health, 'connection lost')
  assert.equal(snapshot.source.read_only, true)
  assert.equal('counts' in snapshot, false)
  assert.equal('last_failure' in snapshot, false)
})
