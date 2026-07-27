# LiveKit voice and video

LiveKit supplies the optional real-time media path. The document is the room:
there is no separate meeting page and opening a document does not join a call.

## What is wired

Open the table-of-contents panel and use its microphone and camera glyphs:

- The microphone joins the document's room. Once joined, the same glyph mutes
  or unmutes the local microphone.
- The camera joins if necessary and then turns the local camera on or off.
  Dragging the camera glyph places the video panel.
- Remote audio is subscribed automatically. Spatial audio is enabled by
  default in the session store and uses Web Audio panning when the browser
  supports it.
- Local and remote camera tracks appear in a `fleet-video` canvas shape, with
  at most four visible tiles. The automatically created shape is removed when
  the call ends.
- Call microphone and participant state is published to the existing speech
  HUD rather than a separate call toolbar.

There is currently no explicit leave button in this UI. A dropped connection,
component teardown, or page exit disconnects the room. Recording and instant
replay are not implemented here.

If the server has no LiveKit credentials, the configuration probe reports
`configured: false`; the microphone cannot join and the camera control says
video chat is not configured. The token route returns HTTP 503.

## Architecture

- `server/routes/livekit.mjs` exposes authenticated `/api/livekit/config` and
  `/api/livekit/token` routes. Tokens last six hours and grant publish,
  subscribe, data-publish, and own-metadata permissions in a sanitized
  `tlda-<project>-<session>` room.
- `src/livekit/liveSession.ts` owns join, mute, camera, spatial-audio, and
  runtime state. The TOC sets intent; the room controller reports runtime
  state.
- `src/livekit/LiveRoomAudio.tsx` is the headless LiveKit controller. It
  connects to the room, publishes local media, attaches remote media, manages
  spatial audio, updates the speech HUD, and cleans up on disconnect.
- `src/panels/TocTab.tsx` renders the microphone and camera controls.
- `src/shapes/FleetVideoShape.tsx` renders the canvas video panel.

## Configuration

The tlda server needs these server-side values:

```sh
LIVEKIT_URL=wss://your-livekit-host
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

`LIVEKIT_WS_URL` may be used as an alternate URL input. The browser receives
only the configured status and scoped token responses from tlda.

For the Fly applications, put those three values in `~/.livekit`, then run:

```sh
scripts/set-livekit-secrets.sh tldraw-sync-skip
scripts/set-livekit-secrets.sh tldraw-sync-skip-stable
```

Setting Fly secrets restarts the selected application. Both deployed Fly
applications currently report `configured: true`, and the live token endpoint
returns room, URL, and token fields. This documentation audit did not perform a
two-client media call, so it does not claim current end-to-end microphone,
camera, or playback verification.
