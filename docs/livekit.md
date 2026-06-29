# LiveKit audit: voice/video collaboration

Status audited: 2026-06-29.

## Bottom line

LiveKit is not live on current `main`. The current checkout has no LiveKit route,
no LiveKit client/server dependencies, and no UI entry point beyond this document.
`rg -i livekit` in the app/server/package surfaces only this file, and
`package.json:32-72` has no `livekit-client` or `livekit-server-sdk`.

The preserved `livekit-rework` branch does contain a real, partly wired
implementation for the intended goal: a "Join voice/video" collaboration option
beside "Link cameras" in the TOC. It is still not deployed here, and this
environment has no LiveKit variables set (`LIVEKIT_URL`, `LIVEKIT_WS_URL`,
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_RECORDING_DIR`, and
`LIVEKIT_SESSION_EVENT_LIMIT` were absent in the audit shell).

## Intended product shape

The goal is: a reader opens the paper, taps a collaboration option beside the
existing "Link cameras" control, and joins a voice/video call with anyone else
who tapped it. That is the right integration point. Current `main` already has
the camera-link option in the TOC at `src/panels/TocTab.tsx:579-594`; it stores
the per-browser preference in `src/cameraLink.ts:18-51`, follows incoming
camera-link signals in `src/hooks/useCameraLink.ts:11-21`, and broadcasts
camera changes only when enabled in `src/SvgDocument.tsx:1587-1598`.

## Current `main`

Dead/inert. There is no app path a user can click to enter a LiveKit room:

- No route is mounted on `main`: the LiveKit route mount exists only on the
  branch at `livekit-rework:server/unified-server.mjs:2491-2494`.
- No dependencies are installed on `main`: the branch adds `livekit-client` and
  `livekit-server-sdk` at `livekit-rework:package.json:60-61`; current
  `package.json:32-72` does not include them.
- No client controller or video shape exists on `main`: those files exist only
  on the branch (`livekit-rework:src/livekit/LiveRoomAudio.tsx:1-17`,
  `livekit-rework:src/shapes/FleetVideoShape.tsx:1-20`).

## Preserved branch implementation

Branch: `livekit-rework` (`f797aa68`, "feat(livekit): live voice/video as a
\"join\" option, no corner chrome").

What exists there:

- Server config/token route. `server/routes/livekit.mjs` imports
  `AccessToken` from `livekit-server-sdk` at
  `livekit-rework:server/routes/livekit.mjs:1-5`, reads
  `LIVEKIT_URL`/`LIVEKIT_WS_URL`, `LIVEKIT_API_KEY`, and
  `LIVEKIT_API_SECRET` at `livekit-rework:server/routes/livekit.mjs:16-20`,
  reports configured status at `livekit-rework:server/routes/livekit.mjs:214-220`,
  and returns `503` with the required keys when unconfigured at
  `livekit-rework:server/routes/livekit.mjs:222-229`.
- Scoped room token minting. The route sanitizes doc/session/identity, uses a
  room name of `tlda-<doc>-<session>`, and grants join/publish/subscribe/data
  privileges at `livekit-rework:server/routes/livekit.mjs:231-265`.
- Join UI beside camera-link. `JoinVoiceVideoToggle` is rendered immediately
  after `CameraLinkToggle` at `livekit-rework:src/panels/TocTab.tsx:585-590`.
  Its configured=false state renders inert "Voice/video off" at
  `livekit-rework:src/panels/TocTab.tsx:614-624`; otherwise it labels
  connecting/connected/error/join states and exposes connected-only mute and
  spatial controls at `livekit-rework:src/panels/TocTab.tsx:627-648`.
- Shared client state. `src/livekit/liveSession.ts` documents the model as
  document-room co-presence beside "Link cameras" at
  `livekit-rework:src/livekit/liveSession.ts:1-15`, stores join/mute/spatial
  intent plus runtime status at `livekit-rework:src/livekit/liveSession.ts:17-47`,
  and probes `/api/livekit/config` at
  `livekit-rework:src/livekit/liveSession.ts:106-120`.
- Headless room controller. `LiveRoomAudio` requests `/api/livekit/token` at
  `livekit-rework:src/livekit/LiveRoomAudio.tsx:101-115`, creates a
  `livekit-client` `Room`, connects with `autoSubscribe`, and starts audio at
  `livekit-rework:src/livekit/LiveRoomAudio.tsx:556-653`. It reacts to the TOC
  join intent at `livekit-rework:src/livekit/LiveRoomAudio.tsx:661-670`.
- Audio/video handling. Remote audio tracks are attached as hidden media
  elements at `livekit-rework:src/livekit/LiveRoomAudio.tsx:430-460`. Remote
  video tracks are stored as `MediaStream`s at
  `livekit-rework:src/livekit/LiveRoomAudio.tsx:461-479`, then shown through a
  locked TLDraw `fleet-video` shape at
  `livekit-rework:src/livekit/LiveRoomAudio.tsx:847-881`.
- Mic status integration. The controller reports call status to the existing
  speech HUD at `livekit-rework:src/livekit/LiveRoomAudio.tsx:694-703`; the HUD
  appends the call segment at `livekit-rework:src/voice.mjs:688-725`.
- TLDraw shape registration. The branch registers `FleetVideoShapeUtil` in the
  client custom utils at `livekit-rework:src/SvgDocument.tsx:68-69` and
  `livekit-rework:src/SvgDocument.tsx:943-943`, and registers the matching
  server schema at `livekit-rework:server/lib/sync-rooms.mjs:290-303`.
- Session metadata/replay scaffolding. The server stores doc/session-scoped
  event feeds and SSE streams at `livekit-rework:server/routes/livekit.mjs:271-327`.
  Recording routes currently write local JSON manifests at
  `livekit-rework:server/routes/livekit.mjs:329-445`; the branch doc is explicit
  that this is not production media egress at
  `livekit-rework:docs/livekit-recording-egress.md:1-4` and lists production
  egress requirements at `livekit-rework:docs/livekit-recording-egress.md:54-66`.
- Tests. `tests/livekit-route.test.mjs` verifies missing config, token scoping,
  session feeds, and recording manifests; see
  `livekit-rework:tests/livekit-route.test.mjs:44-92`,
  `livekit-rework:tests/livekit-route.test.mjs:94-158`, and
  `livekit-rework:tests/livekit-route.test.mjs:344-412`.

## What it is for

The branch implementation is for document-scoped live voice/video meetings. It
is not camera/presenter sync; camera-link already uses tlda/Yjs signals. LiveKit
would handle WebRTC media transport:

- microphone publishing and remote audio playback;
- optional remote video tiles;
- optional spatial audio via Web Audio panners;
- metadata/data plumbing for live-session replay;
- local recording manifests, but not actual production media recording.

## Gaps to wire it for real

1. Bring back or port the branch code to current `main`.
   The app-side pieces are already shaped around the clarified product goal:
   no corner chrome, TOC entry beside "Link cameras", and mic status in the
   existing speech HUD. Porting must include the route mount, dependencies,
   `src/livekit/*`, `FleetVideoShape`, TOC toggle, voice HUD hook, and both
   client/server shape registrations.

2. Provision a LiveKit SFU.
   For the prototype, the branch deployment doc recommends LiveKit Cloud rather
   than self-hosting because Cloud gives `wss://`, TURN, and edge routing; see
   `livekit-rework:docs/livekit-deploy.md:135-152`. Self-hosting is possible but
   requires UDP/TCP fallback, TLS, and TURN work
   (`livekit-rework:docs/livekit-deploy.md:154-168`).

3. Set server secrets.
   The tlda server needs exactly `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and
   `LIVEKIT_API_SECRET`; the client should receive only `/api/livekit/config`
   and scoped `/api/livekit/token` responses. The deploy doc states this contract
   at `livekit-rework:docs/livekit-deploy.md:17-30` and gives the Fly secret
   shape at `livekit-rework:docs/livekit-deploy.md:172-190`.

4. Verify end-to-end media, not just routes.
   Route tests are present, and earlier branch notes claim local/headed proof
   against `livekit-server --dev` and a temporary tailnet SFU at
   `livekit-rework:docs/livekit-audio-handoff.md:114-152`. Before shipping on
   current `main`, repeat this with two real browser sessions: join from the TOC,
   publish/unpublish mic, mute/unmute, join second participant, hear remote
   audio, publish remote camera, see the `fleet-video` tile, leave, and confirm
   cleanup.

5. Decide v1 recording scope.
   Live calling does not require production recording. The branch's recording
   routes are local manifests only; production media capture needs LiveKit
   Egress, storage, lifecycle webhooks, retention policy, and replay wiring
   (`livekit-rework:docs/livekit-recording-egress.md:54-66`). Keep that out of
   the MVP unless recording is explicitly part of the ship goal.

## Recommended path

Ship a narrow v1: port the `livekit-rework` join/mute/audio path, keep the TOC
entry beside `Link cameras`, keep video tile support if it ports cleanly, and
defer recording/instant replay unless needed. Use LiveKit Cloud for the first
working version, set the three server secrets, then run a real two-browser
verification. Only after live two-way audio/video is solid should the replay and
egress work come back into scope.
