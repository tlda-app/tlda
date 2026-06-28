# LiveKit Audio And Replay Handoff

This branch wires a first LiveKit room-audio and live-session replay slice into the app. It is app-side work; ops owns shared/cloud endpoint provisioning and deployment notes.

## Local Run

Start a local LiveKit SFU:

```sh
livekit-server --dev --bind 127.0.0.1 --keys 'devkey: devsecret'
```

The explicit `--keys` pair matters. Plain `livekit-server --dev` uses the default keypair `devkey` / `secret`; if you omit `--keys`, set `LIVEKIT_API_SECRET=secret` instead.

Start the tlda sandbox against a throwaway doc:

```sh
LIVEKIT_URL=ws://127.0.0.1:7880 \
LIVEKIT_API_KEY=devkey \
LIVEKIT_API_SECRET=devsecret \
node cli/tlda-dev.mjs sandbox start --doc livekit-room-audio-test
```

Use the viewer URL reported by the sandbox command or by:

```sh
node cli/tlda-dev.mjs sandbox status --json
```

Do not assume a fixed viewer port. The shared browser can have multiple worktree
servers open; drive the URL for this worktree with `tlda-dev pw`.

## Env Contract

The app server reads these variables:

```text
LIVEKIT_URL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
```

The browser never receives the API secret. It calls:

- `GET /api/livekit/config` for configured status and room URL.
- `POST /api/livekit/token` for a scoped LiveKit token.
- `POST /api/livekit/session/events` to append live-session metadata.
- `GET /api/livekit/session/events` to replay recent session metadata.
- `GET /api/livekit/session/stream` for future live metadata subscribers.
- `POST /api/livekit/recording/start` to create a local recording manifest.
- `POST /api/livekit/recording/stop` to finalize that manifest.
- `GET /api/livekit/recording/artifacts` and `GET /api/livekit/recording/artifacts/:id` to find replay-aligned recording artifacts.

## Session Replay Feed Schema

The replay feed is scoped by sanitized `doc` and `session`; events for one document or session never appear in another feed. `POST /api/livekit/session/events` accepts either `event` or `events`. The server appends:

```ts
{
  seq: number        // monotonically increasing within this doc/session feed
  serverTs: number   // server receive time, epoch ms
  t: number          // client session time in ms
}
```

Supported event bodies:

```ts
type LiveSessionEvent =
  | { kind: 'session'; action: 'started' | 'ended' | 'capabilities'; room?: string; capabilities?: LiveSessionCapabilities }
  | { kind: 'camera'; x: number; y: number; z: number }
  | { kind: 'canvas'; put: TLRecord[]; remove: string[] }
  | { kind: 'participant'; action: 'joined' | 'left'; identity: string; name?: string }
  | { kind: 'track'; action: 'subscribed' | 'unsubscribed'; identity: string; name?: string; trackKey?: string; sid?: string; source?: string; trackKind?: string; subscribedAtMs?: number; unsubscribedAtMs?: number; durationMs?: number }
  | { kind: 'replay-control'; action: 'pause-live' | 'seek' | 'play' | 'pause' | 'return-live'; cursor?: number; windowMs?: number }
  | { kind: 'recording'; action: 'available' | 'started' | 'stopped' | 'failed'; egressId?: string; artifactId?: string; url?: string; status?: string; room?: string; startedAt?: string; stoppedAt?: string; trackCount?: number; participantCount?: number; error?: string }
  | { kind: 'video'; action: 'available' | 'published' | 'unpublished'; identity?: string; sid?: string; source?: string }
  | { kind: 'spatial'; action: 'configured' | 'updated'; enabled: boolean; mode?: string; identity?: string; sid?: string; source?: string; x?: number; y?: number; z?: number; pan?: number; reason?: string }
```

`canvas.put` stores TLDraw records needed to hydrate replay in an isolated store; `canvas.remove` stores record ids removed at that time. Replay consumers must treat these records as historical metadata, not as mutations to the live document.

`GET /api/livekit/session/events` supports bounded reads:

```text
doc=<doc>&session=<session>&cursor=<seq>&limit=<n>
doc=<doc>&session=<session>&since=<seq>&fromMs=<t0>&toMs=<t1>
doc=<doc>&session=<session>&windowMs=<recent-duration>
```

`cursor` and the older `since` alias both return events with `seq > cursor`. `fromMs` and `toMs` bound client session time. `windowMs` returns the recent window ending at the latest event time after cursor filtering. `limit` caps the returned tail, with a server maximum of 5000.

Responses include:

```ts
{
  doc: string
  session: string
  key: string
  events: Array<LiveSessionEvent & { seq: number; serverTs: number }>
  total: number
  count: number
  firstSeq: number
  lastSeq: number
  nextCursor: number
  cursor: number
  limit: number
  window: { fromMs?: number; toMs?: number; windowMs?: number }
}
```

## Verified Slice

Verified locally against `livekit-server --dev`:

```sh
node --test tests/livekit-route.test.mjs
npm run build
```

Headed browser proof on `livekit-room-audio-test`:

- join room via the audio pill;
- publish microphone with a synthetic `getUserMedia` stream;
- receive remote audio from a synthetic second LiveKit participant;
- record participant and track events in `/api/livekit/session/events`;
- record `session started` and `session capabilities` events that advertise room-audio, multitrack metadata, canvas replay, recording, video, and spatial capability flags;
- record canvas and camera events while connected;
- start replay, play through recent canvas/camera history in an isolated canvas PiP, and return live without changing the live camera state;
- browser console after the replay proof had `0` errors and `0` warnings.

Also verified once against a temporary shared tailnet TLS dev SFU:

```text
LIVEKIT_URL=wss://davids-macbook-air-2.cormorant-matrix.ts.net:<ops-provided-port>
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=<ops-provided 48-hex dev secret>
```

That endpoint is ops-managed proof infrastructure, not an app dependency. Per the current
machine policy, do not add persistent auto-start hosting on Air for this slice; use local
`livekit-server` for routine worktree verification unless ops hands over a current shared
endpoint.

Headed browser proof on `livekit-room-audio-test`:

- `/api/livekit/config` returned the `wss://...:8444` URL;
- app room state was `connected`;
- synthetic local microphone published as an unmuted LiveKit audio track;
- synthetic remote participant joined over the same SFU;
- app subscribed to the remote microphone track and the hidden remote audio element reached `readyState: 4` with `paused: false`;
- session feed recorded `session`, `participant`, `track`, and `camera` events;
- rolling audio replay buffer recorded remote track segments;
- replay showed a 360x240 isolated tldraw canvas PiP from session history without adding/removing live document shapes;
- replay muted live remote audio, played a buffered replay audio element, and restored live audio on `live`;
- synthetic remote camera video published over the same SFU rendered inside an owned `fleet-video` HUD/canvas shape;
- the `fleet-video` shape stayed quiet/off when no video track existed and was removed after the synthetic video participant disconnected;
- video metadata recorded both `video available` and `track subscribed` events with participant identity, track kind, and source;
- browser console after the shared-endpoint replay proof had `0` errors and `0` warnings.

## Current Scope

Implemented:

- LiveKit server config and token routes.
- In-memory doc/session event buffer and SSE stream.
- Client room join/disconnect, microphone toggle, remote audio attachment.
- Participant and multitrack audio metadata events, including participant identity, track SID/key, source, subscribe/unsubscribe timing, and track duration.
- Session capability metadata for the implemented and future LiveKit slices.
- Browser-local rolling remote-audio replay buffer for recent LiveKit tracks.
- Canvas and camera metadata capture while a room is active.
- First in-document replay control for canvas/camera metadata.
- `IsolatedCanvasClipPanel`, a renamed copy-store panel based on the old `CanvasClipPanel`, used by LiveKit replay to hydrate history records into a separate tldraw store.
- `liveSessionPlaybackBridge`, which converts LiveKit canvas/camera events into the existing `playback-context` `PlaybackData` shape.
- `fleet-video` HUD/canvas shape for optional participant video tiles, backed by a small LiveKit video registry.
- Local recording manifest egress substitute, documented in `docs/livekit-recording-egress.md`.
- Shared ops deployment notes in `docs/livekit-deploy.md`.

## V0 Playback Alignment

LiveKit replay intentionally does not call `useSyncedPlayback` for the picture-in-picture canvas replay. `useSyncedPlayback` is the V0 whole-document playback path: it fetches `/api/projects/:doc/shapes/at/:ts`, swaps annotation shapes into the live editor, then restores live shapes when playback stops. The LiveKit instant replay requirement is different: replay must happen in a throwaway surface without writing historical shapes into the live document.

The bridge points are:

- `PlaybackFrameShape` / `playback-context`: `src/livekit/liveSessionPlaybackBridge.ts` converts LiveKit canvas/camera events into a `PlaybackData` packet with `livekit:canvas` and `livekit:camera` events.
- `CanvasClipPanel`: `IsolatedCanvasClipPanel` is the old copy-store clip panel extracted for throwaway replay. LiveKit replay hydrates historical records into that isolated store and locks them read-only.
- `useSyncedPlayback`: not used directly for the PiP because it mutates the live editor as part of its restore model. If LiveKit later needs full-document time travel, it should feed the bridge output into a `PlaybackFrameShape`-style container or a `useSyncedPlayback` adapter, not bypass the existing playback broadcast contract.

For headed proof, the browser exposes `window.__tldaLiveSessionReplay`, including replay state, current cursor, replay record count, replay camera, and the bridged `PlaybackData`.

Not complete yet:

- durable event storage beyond process memory;
- production LiveKit Egress media recording integration;

## Continue

Next app-side steps:

1. Replace the local recording manifest substitute with LiveKit Egress service calls once ops defines the deployment contract.
2. Replace or supplement the browser-local audio replay buffer with durable room recording playback.
3. Re-run the focused route tests, `npm run build`, and headed browser proof after each slice.
