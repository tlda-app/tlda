export interface LiveRecordingParticipant {
  identity: string
  name?: string
  metadata?: string
}

export interface LiveRecordingTrack {
  identity: string
  sid?: string
  source?: string
  kind?: string
  name?: string
  participantMetadata?: string
  publicationMetadata?: string
}

export interface LiveRecordingArtifact {
  id: string
  egressId: string
  doc: string
  session: string
  room: string
  status: 'recording' | 'available' | string
  startedAt: string
  stoppedAt?: string
  participants: LiveRecordingParticipant[]
  tracks: LiveRecordingTrack[]
  timeline: {
    events: string
    stream: string
  }
  files: Array<{
    kind: string
    mime: string
    url: string
  }>
}

async function readJson(resp: Response) {
  const body = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(body.error || `LiveKit recording request failed (${resp.status})`)
  return body
}

export async function startLiveRecording({
  doc,
  session,
  room,
  participants,
  tracks,
}: {
  doc: string
  session: string
  room?: string
  participants: LiveRecordingParticipant[]
  tracks: LiveRecordingTrack[]
}): Promise<LiveRecordingArtifact> {
  const body = await fetch('/api/livekit/recording/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc, session, room, participants, tracks }),
  }).then(readJson)
  return body.artifact
}

export async function stopLiveRecording({
  artifactId,
  participants,
  tracks,
}: {
  artifactId: string
  participants: LiveRecordingParticipant[]
  tracks: LiveRecordingTrack[]
}): Promise<LiveRecordingArtifact> {
  const body = await fetch('/api/livekit/recording/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artifactId, participants, tracks }),
  }).then(readJson)
  return body.artifact
}

export async function listLiveRecordings({
  doc,
  session,
}: {
  doc: string
  session: string
}): Promise<LiveRecordingArtifact[]> {
  const q = `doc=${encodeURIComponent(doc)}&session=${encodeURIComponent(session)}`
  const body = await fetch(`/api/livekit/recording/artifacts?${q}`).then(readJson)
  return body.artifacts || []
}
