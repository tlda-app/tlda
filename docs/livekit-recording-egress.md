# LiveKit Recording Egress

This slice connects tlda LiveKit rooms to durable recording metadata. It is the app-side contract for replay alignment; it is not yet a production media egress worker.

## Room Model

Recording is keyed by the same doc/session room identity as live audio:

```text
doc:     <tlda document name>
session: doc-<document name>-live
room:    tlda-<sanitized doc>-<sanitized session>
```

Every recording manifest stores the doc, session, room, participants, tracks, and URLs for the session event feed. Replay can use that one manifest to find:

- LiveKit participant and track identities.
- Audio/video track source metadata.
- Canvas and camera events in `/api/livekit/session/events`.
- Future media object URLs produced by a real LiveKit Egress deployment.

## Local Manifest Substitute

The current implementation writes JSON manifest artifacts to:

```text
LIVEKIT_RECORDING_DIR
```

If unset, the server uses:

```text
server/data/livekit-recordings
```

Routes:

- `POST /api/livekit/recording/start`
- `POST /api/livekit/recording/stop`
- `GET /api/livekit/recording/artifacts?doc=<doc>&session=<session>`
- `GET /api/livekit/recording/artifacts/:id`

Starting a recording writes a `status: "recording"` manifest and emits a `recording started` event into the doc/session feed. Stopping it updates the same manifest to `status: "available"` and emits `recording stopped` plus `recording available` events with the artifact URL.

The browser debug hook exposes the proof path:

```js
await window.__tldaLiveSession.recordingStart()
await window.__tldaLiveSession.recordingStop()
await window.__tldaLiveSession.recordings()
await window.__tldaLiveSession.events()
```

## Production Requirements

A production recording path still needs ops work:

- LiveKit Egress service deployed next to the SFU.
- Object storage credentials and bucket policy for audio/video outputs.
- A server-side egress start/stop worker using the LiveKit Egress API.
- Webhook handling for egress lifecycle, failures, file outputs, and retries.
- Retention, cleanup, and access-control policy for recording artifacts.
- A media layout decision: multitrack raw outputs, composited room output, or both.
- Replay player wiring from manifest files to durable media URLs.

Until those pieces exist, local manifests are the durable app-side substitute. They preserve identity and timeline alignment but do not contain muxed media.
