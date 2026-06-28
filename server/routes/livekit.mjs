import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { Router } from 'express'
import { AccessToken } from 'livekit-server-sdk'
import { requireRead } from '../lib/auth.mjs'

const router = Router()
const MAX_SESSION_EVENTS = Number(process.env.LIVEKIT_SESSION_EVENT_LIMIT || 50_000)
const sessionBuffers = new Map()
const sessionListeners = new Map()

function recordingRoot() {
  return process.env.LIVEKIT_RECORDING_DIR || join(process.cwd(), 'server', 'data', 'livekit-recordings')
}

function livekitConfig() {
  const url = process.env.LIVEKIT_URL || process.env.LIVEKIT_WS_URL || ''
  const apiKey = process.env.LIVEKIT_API_KEY || ''
  const apiSecret = process.env.LIVEKIT_API_SECRET || ''
  return { url, apiKey, apiSecret, configured: !!(url && apiKey && apiSecret) }
}

function cleanPart(value, fallback) {
  const s = String(value || fallback || '').trim().toLowerCase()
  return s.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback
}

function roomName(doc, session) {
  return `tlda-${cleanPart(doc, 'doc')}-${cleanPart(session, 'live')}`
}

function sessionKey(doc, session) {
  return `${cleanPart(doc, 'doc')}::${cleanPart(session, 'live')}`
}

function sessionMeta(doc, session) {
  return {
    doc: cleanPart(doc, 'doc'),
    session: cleanPart(session, 'live'),
    key: sessionKey(doc, session),
  }
}

function getBuffer(key) {
  let buffer = sessionBuffers.get(key)
  if (!buffer) {
    buffer = []
    sessionBuffers.set(key, buffer)
  }
  return buffer
}

function pushSessionEvents(key, rawEvents) {
  const buffer = getBuffer(key)
  const accepted = []
  for (const event of rawEvents) {
    if (!event || typeof event !== 'object') continue
    const next = {
      ...event,
      serverTs: Date.now(),
      seq: buffer.length ? buffer[buffer.length - 1].seq + 1 : 1,
    }
    buffer.push(next)
    accepted.push(next)
  }
  if (buffer.length > MAX_SESSION_EVENTS) {
    buffer.splice(0, buffer.length - MAX_SESSION_EVENTS)
  }
  const listeners = sessionListeners.get(key)
  if (listeners?.size && accepted.length) {
    const payload = JSON.stringify({ type: 'events', events: accepted })
    for (const res of listeners) res.write(`data: ${payload}\n\n`)
  }
  return { buffer, accepted }
}

function cleanNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function cleanPositiveInt(value, fallback, max) {
  const n = Math.floor(cleanNumber(value, fallback))
  return Math.max(1, Math.min(n, max))
}

function sessionWindow(buffer, query) {
  const cursor = Math.max(0, Math.floor(cleanNumber(query.cursor ?? query.since, 0)))
  const limit = cleanPositiveInt(query.limit, 1000, 5000)
  const fromMsRaw = query.fromMs ?? query.from
  const toMsRaw = query.toMs ?? query.to
  const windowMs = Math.max(0, cleanNumber(query.windowMs ?? query.window, 0))
  let events = buffer.filter(e => e.seq > cursor)

  const latestT = events.length ? Math.max(...events.map(e => cleanNumber(e.t, 0))) : 0
  const fromMs = fromMsRaw == null
    ? (windowMs ? Math.max(0, latestT - windowMs) : undefined)
    : Math.max(0, cleanNumber(fromMsRaw, 0))
  const toMs = toMsRaw == null ? undefined : Math.max(0, cleanNumber(toMsRaw, latestT))

  if (fromMs != null) events = events.filter(e => cleanNumber(e.t, 0) >= fromMs)
  if (toMs != null) events = events.filter(e => cleanNumber(e.t, 0) <= toMs)
  events = events.slice(-limit)

  return {
    cursor,
    limit,
    fromMs,
    toMs,
    windowMs: windowMs || undefined,
    events,
  }
}

function recordingArtifactId() {
  return `local-egress-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function recordingArtifactUrl(id) {
  return `/api/livekit/recording/artifacts/${encodeURIComponent(id)}`
}

function sessionTimeline(meta) {
  const q = `doc=${encodeURIComponent(meta.doc)}&session=${encodeURIComponent(meta.session)}`
  return {
    events: `/api/livekit/session/events?${q}`,
    stream: `/api/livekit/session/stream?${q}`,
  }
}

function cleanOptionalString(value, max = 240) {
  if (value == null) return undefined
  const s = String(value).trim()
  return s ? s.slice(0, max) : undefined
}

function cleanMetadata(value) {
  if (value == null) return undefined
  if (typeof value === 'string') return value.slice(0, 4000)
  try {
    return JSON.stringify(value).slice(0, 4000)
  } catch {
    return undefined
  }
}

function cleanParticipants(raw) {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 200).map((p, index) => ({
    identity: cleanOptionalString(p?.identity, 160) || `participant-${index + 1}`,
    name: cleanOptionalString(p?.name, 160),
    metadata: cleanMetadata(p?.metadata),
  }))
}

function cleanTracks(raw) {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 500).map((track, index) => ({
    identity: cleanOptionalString(track?.identity, 160) || 'unknown',
    sid: cleanOptionalString(track?.sid, 160) || `track-${index + 1}`,
    source: cleanOptionalString(track?.source, 80),
    kind: cleanOptionalString(track?.kind || track?.trackKind, 80),
    name: cleanOptionalString(track?.name, 160),
    participantMetadata: cleanMetadata(track?.participantMetadata),
    publicationMetadata: cleanMetadata(track?.publicationMetadata || track?.metadata),
  }))
}

function cleanArtifactId(id) {
  const s = String(id || '').trim()
  if (!/^[a-zA-Z0-9_-]{8,160}$/.test(s)) return ''
  return s
}

function artifactPath(id) {
  return join(recordingRoot(), `${id}.json`)
}

async function writeArtifact(artifact) {
  await fs.mkdir(recordingRoot(), { recursive: true })
  await fs.writeFile(artifactPath(artifact.id), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  return artifact
}

async function readArtifact(id) {
  const cleanId = cleanArtifactId(id)
  if (!cleanId) return null
  try {
    return JSON.parse(await fs.readFile(artifactPath(cleanId), 'utf8'))
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw e
  }
}

async function listArtifacts(meta) {
  let names = []
  try {
    names = await fs.readdir(recordingRoot())
  } catch (e) {
    if (e?.code === 'ENOENT') return []
    throw e
  }
  const artifacts = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const artifact = await readArtifact(name.slice(0, -5))
    if (artifact?.doc === meta.doc && artifact?.session === meta.session) artifacts.push(artifact)
  }
  artifacts.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
  return artifacts
}

router.get('/config', requireRead, (req, res) => {
  const cfg = livekitConfig()
  res.json({
    configured: cfg.configured,
    url: cfg.configured ? cfg.url : '',
  })
})

router.post('/token', requireRead, async (req, res) => {
  const cfg = livekitConfig()
  if (!cfg.configured) {
    return res.status(503).json({
      error: 'LiveKit is not configured',
      required: ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'],
    })
  }

  const doc = cleanPart(req.body?.doc, 'doc')
  const session = cleanPart(req.body?.session, 'live')
  const identity = cleanPart(req.body?.identity, `viewer-${Date.now().toString(36)}`)
  const name = String(req.body?.name || identity).slice(0, 80)
  const room = roomName(doc, session)

  try {
    const token = new AccessToken(cfg.apiKey, cfg.apiSecret, {
      identity,
      name,
      ttl: '6h',
      metadata: JSON.stringify({
        app: 'tlda',
        doc,
        session,
      }),
      attributes: {
        'tlda.doc': doc,
        'tlda.session': session,
      },
    })
    token.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
    })

    res.json({
      url: cfg.url,
      room,
      token: await token.toJwt(),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/session/events', requireRead, (req, res) => {
  const meta = sessionMeta(req.body?.doc, req.body?.session)
  const rawEvents = Array.isArray(req.body?.events) ? req.body.events : [req.body?.event]
  const { buffer, accepted } = pushSessionEvents(meta.key, rawEvents)
  if (!accepted.length) return res.status(400).json({ error: 'events are required' })
  res.json({
    ok: true,
    doc: meta.doc,
    session: meta.session,
    count: accepted.length,
    total: buffer.length,
    lastSeq: buffer.at(-1)?.seq ?? 0,
  })
})

router.get('/session/events', requireRead, (req, res) => {
  const meta = sessionMeta(req.query.doc, req.query.session)
  const buffer = getBuffer(meta.key)
  const window = sessionWindow(buffer, req.query)
  res.json({
    doc: meta.doc,
    session: meta.session,
    key: meta.key,
    events: window.events,
    total: buffer.length,
    count: window.events.length,
    firstSeq: window.events[0]?.seq ?? 0,
    lastSeq: buffer.at(-1)?.seq ?? 0,
    nextCursor: buffer.at(-1)?.seq ?? 0,
    cursor: window.cursor,
    limit: window.limit,
    window: {
      fromMs: window.fromMs,
      toMs: window.toMs,
      windowMs: window.windowMs,
    },
  })
})

router.get('/session/stream', requireRead, (req, res) => {
  const meta = sessionMeta(req.query.doc, req.query.session)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write(`data: ${JSON.stringify({ type: 'connected', doc: meta.doc, session: meta.session })}\n\n`)
  const listeners = sessionListeners.get(meta.key) ?? new Set()
  listeners.add(res)
  sessionListeners.set(meta.key, listeners)
  const keepalive = setInterval(() => res.write(':\n\n'), 15000)
  req.on('close', () => {
    clearInterval(keepalive)
    listeners.delete(res)
    if (listeners.size === 0) sessionListeners.delete(meta.key)
  })
})

router.post('/recording/start', requireRead, async (req, res) => {
  const meta = sessionMeta(req.body?.doc, req.body?.session)
  const now = new Date().toISOString()
  const id = recordingArtifactId()
  const artifact = {
    kind: 'livekit-recording-manifest',
    version: 1,
    id,
    egressId: id,
    doc: meta.doc,
    session: meta.session,
    room: cleanOptionalString(req.body?.room, 200) || roomName(meta.doc, meta.session),
    status: 'recording',
    production: false,
    storage: 'local-manifest',
    startedAt: now,
    updatedAt: now,
    participants: cleanParticipants(req.body?.participants),
    tracks: cleanTracks(req.body?.tracks),
    timeline: sessionTimeline(meta),
    files: [
      {
        kind: 'manifest',
        mime: 'application/json',
        url: recordingArtifactUrl(id),
      },
    ],
  }
  await writeArtifact(artifact)
  pushSessionEvents(meta.key, [{
    t: Number(req.body?.t ?? 0),
    kind: 'recording',
    action: 'started',
    egressId: id,
    artifactId: id,
    status: artifact.status,
    room: artifact.room,
    url: recordingArtifactUrl(id),
    startedAt: artifact.startedAt,
    trackCount: artifact.tracks.length,
    participantCount: artifact.participants.length,
  }])
  res.json({ ok: true, artifact })
})

router.post('/recording/stop', requireRead, async (req, res) => {
  const id = cleanArtifactId(req.body?.artifactId || req.body?.egressId)
  if (!id) return res.status(400).json({ error: 'artifactId is required' })
  const existing = await readArtifact(id)
  if (!existing) return res.status(404).json({ error: 'recording artifact not found' })
  const meta = sessionMeta(existing.doc, existing.session)
  const now = new Date().toISOString()
  const nextTracks = Array.isArray(req.body?.tracks) ? cleanTracks(req.body.tracks) : existing.tracks
  const nextParticipants = Array.isArray(req.body?.participants) ? cleanParticipants(req.body.participants) : existing.participants
  const artifact = {
    ...existing,
    status: 'available',
    stoppedAt: now,
    updatedAt: now,
    participants: nextParticipants,
    tracks: nextTracks,
    files: existing.files?.length ? existing.files : [
      {
        kind: 'manifest',
        mime: 'application/json',
        url: recordingArtifactUrl(id),
      },
    ],
  }
  await writeArtifact(artifact)
  pushSessionEvents(meta.key, [
    {
      t: Number(req.body?.t ?? 0),
      kind: 'recording',
      action: 'stopped',
      egressId: id,
      artifactId: id,
      status: artifact.status,
      room: artifact.room,
      url: recordingArtifactUrl(id),
      stoppedAt: artifact.stoppedAt,
      trackCount: artifact.tracks.length,
      participantCount: artifact.participants.length,
    },
    {
      t: Number(req.body?.t ?? 0),
      kind: 'recording',
      action: 'available',
      egressId: id,
      artifactId: id,
      status: artifact.status,
      room: artifact.room,
      url: recordingArtifactUrl(id),
      stoppedAt: artifact.stoppedAt,
      trackCount: artifact.tracks.length,
      participantCount: artifact.participants.length,
    },
  ])
  res.json({ ok: true, artifact })
})

router.get('/recording/artifacts', requireRead, async (req, res) => {
  const meta = sessionMeta(req.query.doc, req.query.session)
  const artifacts = await listArtifacts(meta)
  res.json({
    doc: meta.doc,
    session: meta.session,
    artifacts,
    total: artifacts.length,
  })
})

router.get('/recording/artifacts/:id', requireRead, async (req, res) => {
  const artifact = await readArtifact(req.params.id)
  if (!artifact) return res.status(404).json({ error: 'recording artifact not found' })
  res.json(artifact)
})

export default router
