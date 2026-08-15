import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function publicationDir(recordingsDir) {
  return join(recordingsDir, 'publication')
}

function publicationPath(recordingsDir, recordingId) {
  return join(publicationDir(recordingsDir), `${recordingId}.json`)
}

export function readRecordingPublication(recordingsDir, recordingId) {
  const path = publicationPath(recordingsDir, recordingId)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

function validateInterval(recording, interval) {
  const startMs = interval?.startMs
  const endMs = interval?.endMs
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new TypeError('Class interval needs finite startMs and endMs')
  }
  if (startMs < 0 || endMs <= startMs || endMs > recording.duration_ms) {
    throw new RangeError(`Class interval must satisfy 0 <= startMs < endMs <= ${recording.duration_ms}`)
  }
  return { startMs, endMs }
}

export function writeCandidateClip(recordingsDir, recording, interval, actor, now = new Date()) {
  const { startMs, endMs } = validateInterval(recording, interval)
  const previous = readRecordingPublication(recordingsDir, recording.id)
  const record = {
    recordingId: recording.id,
    state: 'candidate-clip',
    startMs,
    endMs,
    proposedBy: actor,
    proposedAt: now.toISOString(),
    created: previous?.created ?? now.toISOString(),
    updated: now.toISOString(),
  }
  const dir = publicationDir(recordingsDir)
  mkdirSync(dir, { recursive: true })
  const path = publicationPath(recordingsDir, recording.id)
  const pendingPath = `${path}.pending`
  writeFileSync(pendingPath, JSON.stringify(record))
  renameSync(pendingPath, path)
  return record
}

export function writeOwnerInterval(recordingsDir, recording, interval, actor, now = new Date()) {
  const previous = readRecordingPublication(recordingsDir, recording.id)
  if (previous?.state !== 'candidate-clip') throw new Error('Recording needs an agent proposal before owner review')
  const { startMs, endMs } = validateInterval(recording, interval)
  const record = { ...previous, startMs, endMs, ownerEditedBy: actor, ownerEditedAt: now.toISOString(), updated: now.toISOString() }
  const path = publicationPath(recordingsDir, recording.id)
  const pendingPath = `${path}.pending`
  writeFileSync(pendingPath, JSON.stringify(record))
  renameSync(pendingPath, path)
  return record
}

export function writePublishedRecording(recordingsDir, recording, actor, now = new Date()) {
  const candidate = readRecordingPublication(recordingsDir, recording.id)
  if (candidate?.state !== 'candidate-clip') {
    throw new Error('Recording needs a reviewed class interval before publication')
  }
  if (!candidate.ownerEditedBy) throw new Error('Owner must confirm the class interval before publication')
  const { startMs, endMs } = validateInterval(recording, candidate)
  const record = { ...candidate, state: 'published', startMs, endMs, committedBy: actor, committedAt: now.toISOString(), updated: now.toISOString() }
  const path = publicationPath(recordingsDir, recording.id)
  const pendingPath = `${path}.pending`
  writeFileSync(pendingPath, JSON.stringify(record))
  renameSync(pendingPath, path)
  return record
}

export function clipRecordingData(recording, publication) {
  const { startMs, endMs } = publication
  const visible = new Map()
  let camera = null
  for (const event of recording.events) {
    if (event.t >= startMs) break
    if (event.kind === 'camera') {
      camera = event
      continue
    }
    if (event.kind === 'base') {
      visible.clear()
      continue
    }
    for (const record of event.put) visible.set(record.id, record)
    for (const id of event.remove) visible.delete(id)
  }

  const events = []
  const base = [...recording.events].reverse().find(event => event.kind === 'base' && event.t <= startMs)
  if (base) events.push({ ...base, t: 0 })
  if (camera) events.push({ ...camera, t: 0 })
  if (visible.size) events.push({ t: 0, kind: 'stroke', put: [...visible.values()], remove: [] })
  for (const event of recording.events) {
    if (event.t < startMs) continue
    if (event.t > endMs) break
    events.push({ ...event, t: event.t - startMs })
  }

  return {
    ...recording,
    id: `${recording.id}-published`,
    duration_ms: endMs - startMs,
    events,
    rawRecordingId: recording.id,
  }
}
