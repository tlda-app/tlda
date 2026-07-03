# LiveKit live voice/video

Status: landable MVP worktree, 2026-07-03.

## Product shape

The document is the shared room. Joining voice/video is another facet of
co-presence on a paper, beside "Link cameras." There is no always-on corner
chrome: a plain document open does not draw call UI. A reader joins from the TOC
panel, and once connected the mic state folds into the existing dictation speech
HUD.

## User flow

1. Open a document.
2. In the TOC panel, use **Join voice/video** under **Link cameras**.
3. While connected, the line changes to **In voice/video** and exposes contextual
   **Mute mic / Unmute mic** and **Spatial audio** options.
4. Mic status appears in the bottom-center speech HUD. The HUD uses the same
   surface as dictation, so dictation and call state do not compete.
5. Remote video, when published, appears as one locked TLDraw `fleet-video`
   shape with up to four tiles.
6. Tap **In voice/video** again to leave.

If the server has no LiveKit credentials, the option renders as inert
**Voice/video off** and `/api/livekit/token` returns 503.

## Architecture

- `server/routes/livekit.mjs` exposes `/api/livekit/config` and
  `/api/livekit/token`. Tokens are scoped to a sanitized document/session room:
  `tlda-<doc>-<session>`.
- `src/livekit/liveSession.ts` owns join, mute, spatial-audio, and runtime state.
  The TOC sets intent; the room controller reports runtime status.
- `src/livekit/LiveRoomAudio.tsx` is the headless LiveKit controller. It connects
  to the room, publishes the local mic, attaches remote audio, tracks optional
  remote video, updates the speech HUD, and cleans up on leave.
- `src/panels/TocTab.tsx` renders the subtle TOC entry beside the existing
  camera-link control.
- `src/shapes/FleetVideoShape.tsx` implements the TLDraw video tile shape. Its
  props are registered in both the client shape util and
  `server/lib/sync-rooms.mjs`.
- Recording, instant replay, and classroom/session-feed machinery are outside
  this MVP slice.

## Configuration

The tlda server needs these server-side values:

```sh
LIVEKIT_URL=wss://your-livekit-host
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

`LIVEKIT_WS_URL` may be used as an alternate URL input. The browser receives only
the configured status and scoped token responses from tlda.

## Verification target

For the MVP, verify the route/token path and a real two-client LiveKit call:
join from the TOC, publish mic, subscribe/play remote audio, mute/unmute, leave,
and clean up. Video support should ship when the browser proof shows a remote
camera tile appears and is removed on leave.
