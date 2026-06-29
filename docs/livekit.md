# LiveKit (live voice/video) — shelved feature

**Status (2026-06-28):** Removed from the live build. The code is preserved on a feature branch, not on `main`/live. It is inert without configuration (see below). When it returns, its voice/audio status must fold into the existing dictation speech HUD — no standalone floating indicator — and it must be documented before shipping.

## What it's for (intended)
A live voice/video room attached to each document, so two people viewing the same paper can talk and see each other in real time while reviewing. Includes a "spatial audio" option (positioning each person's voice in the stereo field) and an instant-replay/recording of the live session.

## What it actually did
On every document open it unconditionally drew a faint cluster of controls in the corner chrome: a green "audio" dot, an olive "spatial" button, and a replay element — always-on chrome, not the result of joining anything. The green "audio/spatial" indicator that appeared on screen was just these labels sitting there. The spatial button stayed disabled until an actual connection; clicking "audio" tried to join a room; if anyone connected with video, a locked "live video" tile was dropped on the canvas.

## Is it real / status
Partly. The plumbing is real (real `livekit-client` library, a real server token route), but it requires three configured secrets: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`. Without them the server returns 503 "LiveKit is not configured" and clicking does nothing — so it was mostly inert chrome. The original commit (`5c512ea7`) was a "preserve uncommitted WIP" snapshot, self-described as not verified for deploy, that nonetheless landed on `main` and surfaced the corner UI; it has since been removed from live (build `ec9a6c2c`).

## Source pointers
`src/livekit/LiveRoomAudio.tsx`, `src/shapes/FleetVideoShape.tsx`, `server/routes/livekit.mjs` (on the feature branch).
