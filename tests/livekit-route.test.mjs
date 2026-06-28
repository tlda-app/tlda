import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import express from 'express'
import livekitRoutes from '../server/routes/livekit.mjs'

function withEnv(env, fn) {
  const previous = {}
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key]
    if (env[key] == null) delete process.env[key]
    else process.env[key] = env[key]
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key]
        else process.env[key] = value
      }
    })
}

async function withApp(fn) {
  const app = express()
  app.use(express.json())
  app.use('/api/livekit', livekitRoutes)
  const server = createServer(app)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    server.close()
    await once(server, 'close')
  }
}

test('LiveKit config and token route report missing server configuration', async () => {
  await withEnv({
    LIVEKIT_URL: null,
    LIVEKIT_WS_URL: null,
    LIVEKIT_API_KEY: null,
    LIVEKIT_API_SECRET: null,
  }, () => withApp(async (base) => {
    const config = await fetch(`${base}/api/livekit/config`).then(r => r.json())
    assert.deepEqual(config, { configured: false, url: '' })

    const resp = await fetch(`${base}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc: 'Doc With Spaces', session: 'Main Session' }),
    })
    assert.equal(resp.status, 503)
    const body = await resp.json()
    assert.equal(body.error, 'LiveKit is not configured')
    assert.deepEqual(body.required, ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'])
  }))
})

test('LiveKit token route scopes a signed token to sanitized doc/session room', async () => {
  await withEnv({
    LIVEKIT_URL: 'wss://livekit.example.test',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'devsecret',
  }, () => withApp(async (base) => {
    const config = await fetch(`${base}/api/livekit/config`).then(r => r.json())
    assert.deepEqual(config, { configured: true, url: 'wss://livekit.example.test' })

    const resp = await fetch(`${base}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        doc: 'LiveKit Room Audio Test',
        session: 'Doc Live',
        identity: 'Agent @ Device',
        name: 'Agent Name',
      }),
    })
    assert.equal(resp.status, 200)
    const body = await resp.json()
    assert.equal(body.url, 'wss://livekit.example.test')
    assert.equal(body.room, 'tlda-livekit-room-audio-test-doc-live')
    assert.equal(typeof body.token, 'string')
    assert.equal(body.token.split('.').length, 3)
  }))
})

test('LiveKit session event feed stores and streams doc/session scoped events', async () => {
  await withEnv({}, () => withApp(async (base) => {
    const doc = `livekit-route-${Date.now()}`
    const session = 'doc-live'

    const first = await fetch(`${base}/api/livekit/session/events?doc=${doc}&session=${session}`).then(r => r.json())
    assert.equal(first.total, 0)
    assert.deepEqual(first.events, [])

    const post = await fetch(`${base}/api/livekit/session/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        doc,
        session,
        events: [
          {
            t: 0,
            kind: 'session',
            action: 'started',
            room: 'tlda-livekit-route-doc-live',
            capabilities: {
              roomAudio: true,
              multitrackMetadata: true,
              canvasReplay: true,
              recording: false,
              video: false,
              spatialAudio: false,
            },
          },
          { t: 0, kind: 'participant', action: 'joined', identity: 'alice' },
          { t: 12, kind: 'camera', x: 1, y: 2, z: 3 },
          { t: 13, kind: 'recording', action: 'available', egressId: 'pending' },
          { t: 14, kind: 'video', action: 'available', source: 'camera' },
          { t: 15, kind: 'spatial', action: 'configured', enabled: false, mode: 'off' },
        ],
      }),
    })
    assert.equal(post.status, 200)
    assert.deepEqual(await post.json(), {
      ok: true,
      doc,
      session,
      count: 6,
      total: 6,
      lastSeq: 6,
    })

    const all = await fetch(`${base}/api/livekit/session/events?doc=${doc}&session=${session}`).then(r => r.json())
    assert.equal(all.total, 6)
    assert.equal(all.lastSeq, 6)
    assert.deepEqual(all.events.map(e => [e.seq, e.kind]), [
      [1, 'session'],
      [2, 'participant'],
      [3, 'camera'],
      [4, 'recording'],
      [5, 'video'],
      [6, 'spatial'],
    ])
    assert.equal(typeof all.events[0].serverTs, 'number')

    const since = await fetch(`${base}/api/livekit/session/events?doc=${doc}&session=${session}&since=1`).then(r => r.json())
    assert.deepEqual(since.events.map(e => e.kind), ['participant', 'camera', 'recording', 'video', 'spatial'])
  }))
})

test('LiveKit session feed preserves multitrack participant timing metadata', async () => {
  await withEnv({}, () => withApp(async (base) => {
    const doc = `multitrack-doc-${Date.now()}`
    const session = 'doc-live'

    const post = await fetch(`${base}/api/livekit/session/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        doc,
        session,
        events: [
          {
            t: 100,
            kind: 'track',
            action: 'subscribed',
            identity: 'alice',
            name: 'Alice',
            trackKey: 'alice:TR_ALICE',
            sid: 'TR_ALICE',
            source: 'microphone',
            trackKind: 'audio',
            subscribedAtMs: 100,
          },
          {
            t: 150,
            kind: 'track',
            action: 'subscribed',
            identity: 'bob',
            name: 'Bob',
            trackKey: 'bob:TR_BOB',
            sid: 'TR_BOB',
            source: 'microphone',
            trackKind: 'audio',
            subscribedAtMs: 150,
          },
          {
            t: 450,
            kind: 'track',
            action: 'unsubscribed',
            identity: 'alice',
            name: 'Alice',
            trackKey: 'alice:TR_ALICE',
            sid: 'TR_ALICE',
            source: 'microphone',
            trackKind: 'audio',
            subscribedAtMs: 100,
            unsubscribedAtMs: 450,
            durationMs: 350,
          },
        ],
      }),
    })
    assert.equal(post.status, 200)

    const all = await fetch(`${base}/api/livekit/session/events?doc=${doc}&session=${session}`).then(r => r.json())
    assert.deepEqual(all.events.map(e => ({
      action: e.action,
      identity: e.identity,
      trackKey: e.trackKey,
      sid: e.sid,
      source: e.source,
      trackKind: e.trackKind,
      subscribedAtMs: e.subscribedAtMs,
      unsubscribedAtMs: e.unsubscribedAtMs,
      durationMs: e.durationMs,
    })), [
      {
        action: 'subscribed',
        identity: 'alice',
        trackKey: 'alice:TR_ALICE',
        sid: 'TR_ALICE',
        source: 'microphone',
        trackKind: 'audio',
        subscribedAtMs: 100,
        unsubscribedAtMs: undefined,
        durationMs: undefined,
      },
      {
        action: 'subscribed',
        identity: 'bob',
        trackKey: 'bob:TR_BOB',
        sid: 'TR_BOB',
        source: 'microphone',
        trackKind: 'audio',
        subscribedAtMs: 150,
        unsubscribedAtMs: undefined,
        durationMs: undefined,
      },
      {
        action: 'unsubscribed',
        identity: 'alice',
        trackKey: 'alice:TR_ALICE',
        sid: 'TR_ALICE',
        source: 'microphone',
        trackKind: 'audio',
        subscribedAtMs: 100,
        unsubscribedAtMs: 450,
        durationMs: 350,
      },
    ])
  }))
})

test('LiveKit session feed supports doc-scoped cursor and time-window reads', async () => {
  await withEnv({}, () => withApp(async (base) => {
    const doc = `replay-window-doc-${Date.now()}`
    const otherDoc = `${doc}-other`
    const session = 'doc-live'

    const post = await fetch(`${base}/api/livekit/session/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        doc,
        session,
        events: [
          { t: 0, kind: 'camera', x: 0, y: 0, z: 1 },
          {
            t: 100,
            kind: 'canvas',
            put: [{ id: 'shape:one', typeName: 'shape', type: 'geo', props: { w: 10, h: 10 } }],
            remove: [],
          },
          { t: 200, kind: 'track', action: 'subscribed', identity: 'alice', trackKey: 'alice:TR_A', sid: 'TR_A', source: 'microphone', trackKind: 'audio', subscribedAtMs: 200 },
          { t: 300, kind: 'replay-control', action: 'pause-live', cursor: 2, windowMs: 200 },
        ],
      }),
    })
    assert.equal(post.status, 200)

    const otherPost = await fetch(`${base}/api/livekit/session/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        doc: otherDoc,
        session,
        event: { t: 999, kind: 'camera', x: 9, y: 9, z: 1 },
      }),
    })
    assert.equal(otherPost.status, 200)

    const cursor = await fetch(`${base}/api/livekit/session/events?doc=${doc}&session=${session}&cursor=2`).then(r => r.json())
    assert.equal(cursor.total, 4)
    assert.equal(cursor.count, 2)
    assert.equal(cursor.firstSeq, 3)
    assert.equal(cursor.lastSeq, 4)
    assert.equal(cursor.nextCursor, 4)
    assert.equal(cursor.cursor, 2)
    assert.deepEqual(cursor.events.map(e => [e.seq, e.kind]), [
      [3, 'track'],
      [4, 'replay-control'],
    ])
    assert.equal(cursor.events[1].action, 'pause-live')
    assert.equal(cursor.events[1].windowMs, 200)

    const bounded = await fetch(`${base}/api/livekit/session/events?doc=${doc}&session=${session}&fromMs=90&toMs=210`).then(r => r.json())
    assert.deepEqual(bounded.events.map(e => [e.seq, e.kind]), [
      [2, 'canvas'],
      [3, 'track'],
    ])
    assert.deepEqual(bounded.window, { fromMs: 90, toMs: 210 })

    const recent = await fetch(`${base}/api/livekit/session/events?doc=${doc}&session=${session}&windowMs=150`).then(r => r.json())
    assert.deepEqual(recent.events.map(e => [e.seq, e.kind]), [
      [3, 'track'],
      [4, 'replay-control'],
    ])
    assert.deepEqual(recent.window, { fromMs: 150, windowMs: 150 })

    const limited = await fetch(`${base}/api/livekit/session/events?doc=${doc}&session=${session}&windowMs=500&limit=1`).then(r => r.json())
    assert.deepEqual(limited.events.map(e => [e.seq, e.kind]), [
      [4, 'replay-control'],
    ])
    assert.equal(limited.count, 1)

    const isolated = await fetch(`${base}/api/livekit/session/events?doc=${otherDoc}&session=${session}`).then(r => r.json())
    assert.equal(isolated.total, 1)
    assert.deepEqual(isolated.events.map(e => [e.seq, e.kind, e.x]), [
      [1, 'camera', 9],
    ])
  }))
})

test('LiveKit recording routes write durable manifests and attach them to the session feed', async () => {
  const recordingDir = await mkdtemp(join(tmpdir(), 'tlda-livekit-recordings-'))
  try {
    await withEnv({ LIVEKIT_RECORDING_DIR: recordingDir }, () => withApp(async (base) => {
      const doc = `recording-doc-${Date.now()}`
      const session = 'doc-live'
      const room = 'tlda-recording-doc-live'
      const participants = [
        { identity: 'presenter', name: 'Presenter', metadata: JSON.stringify({ role: 'presenter' }) },
        { identity: 'viewer', name: 'Viewer' },
      ]
      const tracks = [
        {
          identity: 'presenter',
          sid: 'TR_AUDIO',
          source: 'microphone',
          kind: 'audio',
          participantMetadata: participants[0].metadata,
          publicationMetadata: JSON.stringify({ angle: -30 }),
        },
        {
          identity: 'viewer',
          sid: 'TR_CAMERA',
          source: 'camera',
          kind: 'video',
        },
      ]

      const startResp = await fetch(`${base}/api/livekit/recording/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ doc, session, room, participants, tracks }),
      })
      assert.equal(startResp.status, 200)
      const started = await startResp.json()
      assert.equal(started.ok, true)
      assert.equal(started.artifact.doc, doc)
      assert.equal(started.artifact.session, session)
      assert.equal(started.artifact.room, room)
      assert.equal(started.artifact.status, 'recording')
      assert.equal(started.artifact.tracks.length, 2)
      assert.equal(started.artifact.participants.length, 2)
      assert.equal(started.artifact.timeline.events, `/api/livekit/session/events?doc=${doc}&session=${session}`)

      const artifactId = started.artifact.id
      const startedEvents = await fetch(`${base}/api/livekit/session/events?doc=${doc}&session=${session}`).then(r => r.json())
      assert.deepEqual(startedEvents.events.map(e => [e.kind, e.action, e.artifactId]), [
        ['recording', 'started', artifactId],
      ])

      const stopResp = await fetch(`${base}/api/livekit/recording/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ artifactId, participants, tracks }),
      })
      assert.equal(stopResp.status, 200)
      const stopped = await stopResp.json()
      assert.equal(stopped.ok, true)
      assert.equal(stopped.artifact.status, 'available')
      assert.equal(stopped.artifact.tracks[0].identity, 'presenter')
      assert.equal(stopped.artifact.tracks[0].sid, 'TR_AUDIO')
      assert.equal(stopped.artifact.files[0].url, `/api/livekit/recording/artifacts/${artifactId}`)

      const artifact = await fetch(`${base}/api/livekit/recording/artifacts/${artifactId}`).then(r => r.json())
      assert.equal(artifact.status, 'available')
      assert.equal(artifact.timeline.stream, `/api/livekit/session/stream?doc=${doc}&session=${session}`)
      assert.equal(artifact.tracks[1].kind, 'video')

      const listed = await fetch(`${base}/api/livekit/recording/artifacts?doc=${doc}&session=${session}`).then(r => r.json())
      assert.equal(listed.total, 1)
      assert.equal(listed.artifacts[0].id, artifactId)

      const allEvents = await fetch(`${base}/api/livekit/session/events?doc=${doc}&session=${session}`).then(r => r.json())
      assert.deepEqual(allEvents.events.map(e => [e.kind, e.action, e.artifactId, e.url]), [
        ['recording', 'started', artifactId, `/api/livekit/recording/artifacts/${artifactId}`],
        ['recording', 'stopped', artifactId, `/api/livekit/recording/artifacts/${artifactId}`],
        ['recording', 'available', artifactId, `/api/livekit/recording/artifacts/${artifactId}`],
      ])
    }))
  } finally {
    await rm(recordingDir, { recursive: true, force: true })
  }
})
