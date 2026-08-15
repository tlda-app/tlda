import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { clipRecordingData, readRecordingPublication, writeCandidateClip, writeOwnerInterval, writePublishedRecording } from './recording-publication.mjs'

test('publication requires a separately persisted class interval with editable head and tail cuts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-recording-publication-'))
  try {
    const raw = { id: 'lecture-1', duration_ms: 60_000 }
    assert.throws(() => writePublishedRecording(dir, raw, 'classroom:rw'), /reviewed class interval/)
    const candidate = writeCandidateClip(dir, raw, { startMs: 5_000, endMs: 52_000 }, 'fleet:agent', new Date('2026-08-15T04:00:00.000Z'))
    assert.equal(candidate.state, 'candidate-clip')
    assert.equal(candidate.startMs, 5_000)
    assert.equal(candidate.endMs, 52_000)
    assert.throws(() => writePublishedRecording(dir, raw, 'classroom:rw'), /Owner must confirm/)
    const edited = writeOwnerInterval(dir, raw, { startMs: 7_000, endMs: 50_000 }, 'classroom:rw', new Date('2026-08-15T04:04:00.000Z'))
    assert.equal(edited.proposedBy, 'fleet:agent')
    assert.equal(edited.ownerEditedBy, 'classroom:rw')
    const published = writePublishedRecording(dir, raw, 'classroom:rw', new Date('2026-08-15T04:05:00.000Z'))
    assert.equal(published.state, 'published')
    assert.equal(published.startMs, 7_000)
    assert.equal(published.endMs, 50_000)
    assert.equal(published.committedBy, 'classroom:rw')
    assert.deepEqual(readRecordingPublication(dir, 'lecture-1'), published)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('published replay carries annotation and camera events on the recording clock', () => {
  const recording = {
    id: 'lecture-1',
    duration_ms: 10_000,
    events: [
      { t: 0, kind: 'camera', x: 1, y: 2, z: 3 },
      { t: 2_000, kind: 'stroke', put: [{ id: 'shape:a', typeName: 'shape' }], remove: [] },
    ],
  }
  const published = clipRecordingData(recording, { startMs: 0, endMs: 10_000 })
  assert.equal(published.id, 'lecture-1-published')
  assert.equal(published.duration_ms, 10_000)
  assert.deepEqual(published.events, recording.events)
})

test('published replay rebases the selected class interval and keeps its frozen base', () => {
  const base = { store: { schema: {}, records: {} }, schema: {} }
  const recording = {
    id: 'lecture-interval',
    duration_ms: 10_000,
    events: [
      { t: 0, kind: 'base', snapshot: base },
      { t: 1_000, kind: 'camera', x: 1, y: 2, z: 3 },
      { t: 4_000, kind: 'stroke', put: [{ id: 'shape:a', typeName: 'shape' }], remove: [] },
      { t: 8_000, kind: 'camera', x: 4, y: 5, z: 6 },
    ],
  }
  const published = clipRecordingData(recording, { startMs: 3_000, endMs: 7_000 })
  assert.equal(published.duration_ms, 4_000)
  assert.equal(published.events[0].kind, 'base')
  assert.equal(published.events[0].t, 0)
  assert.deepEqual(published.events.find(event => event.kind === 'camera'), { t: 0, kind: 'camera', x: 1, y: 2, z: 3 })
  assert.equal(published.events.find(event => event.kind === 'stroke').t, 1_000)
  assert.equal(published.events.some(event => event.t === 8_000), false)
})

test('candidate interval can be revised before the explicit publication commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-recording-publication-'))
  try {
    const raw = { id: 'lecture-2', duration_ms: 60_000 }
    writeCandidateClip(dir, raw, { startMs: 1_000, endMs: 59_000 }, 'fleet:agent-1')
    const revised = writeCandidateClip(dir, raw, { startMs: 7_000, endMs: 48_000 }, 'fleet:agent')
    assert.equal(revised.state, 'candidate-clip')
    assert.equal(revised.startMs, 7_000)
    assert.equal(revised.endMs, 48_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
