# Voice path — known defects, not yet fixed

Found 2026-07-25 while diagnosing "intermittent voice reconnecting." **None of these are
that bug**, and none are fixed. They were found by inventorying the voice path and are
recorded here so the next person starts with a map instead of earning one.

The bug that *was* fixed: the speech epoch was a closure parameter on the Deepgram
socket, so advancing it required a redial — which fired after every message Skip sent
(68 redials in 46 minutes, with every upstream failure path measured at zero). See the
`voice-reconnect` commits.

Ordered by how much they'd cost someone. That ordering is a judgement call and won't
reproduce itself, so it's the main thing this list carries.

---

## 1. `src/inputModes.ts` is a dead voice on/off module

An entire module — `getVoiceEnabled`, `setInputMode`, `subscribeInputModes`, and its own
`tlda-input-voice` localStorage key — with **zero importers anywhere in the repo**.
Superseded by the `voice-backend` preference and never removed.

Straight deletion, about five minutes. The only reason it has survived is that nobody
knew it was there.

## 2. Two 1 Hz timers both run while recording

`_voiceLivenessInterval` (`voice.mjs:751`) and `_audioHeartbeatInterval` (`:2559`).

The comment at `voice.mjs:2615` states that the heartbeat's status duty *was moved* to
`runVoiceLivenessWatchdog` — so this is a replacement that landed with the old mechanism
left running on a narrowed job. The heartbeat can still independently tear down and
rebuild the mic pipeline (`:2610`), and the two timers are cleared by different
functions: `hardResetVoice({ keepDeepgramMic: true })` stops the liveness watchdog and
leaves the audio heartbeat running.

## 3. `visibilitychange` bypasses the reconnect scheduler

`voice.mjs:3075` calls `connectDeepgramBridge()` directly, while `relay.onclose`
(`:2446`) arms a 1 s `scheduleDeepgramReconnect`. Two deciders for one reconnect; a tab
that backgrounds and returns around a close can drive both.

Not demonstrated to fire in production — the obvious evidence for it (bridge-side
`browser connected` counts) is unusable, see §6. Left alone rather than fixed on
suspicion.

## 4. `loadVoiceParamOverrides()` is a gutted hook that log-spams

`deepgram-sdk-bridge.mjs:109` returns `{}` unconditionally but is still wired into
`listenOptions()`, which logs `voiceParams overrides applied` and `effective listen
options` on **every call**. `epochQueueMaxBytes()` calls `listenOptions()` purely to read
a number, so those lines appear without any connection being made.

Concrete cost: this inflated the first attribution attempt during the reconnect
diagnosis. Anyone counting reconnects by those lines gets a wrong answer.

## 5. `/api/voice/whisper/start` hand-rolls its own bridge probe

`unified-server.mjs:2793` inlines an 800 ms WebSocket probe instead of using
`isBridgeUp()` (`:2852`), the generalized version every other caller uses. The inline
copy omits `rejectUnauthorized: false`, so it fails against a TLS whisper bridge — and
`whisper-bridge.mjs:90` starts one whenever the mkcert certs exist.

## 6. Dead residue

- `ensureDontSpeakOverlay()` (`voice.mjs:792`) builds a full-screen overlay that nothing
  calls; `hideDontSpeak()` still references the permanently-null `_dontSpeakOverlay`.
- `_lastTapTime`, `_singleTapTimer`, `DOUBLE_TAP_MS` — declared, never read. Leftovers of
  the pre-`voiceTap()` tap detection, which now uses `_voiceTapCount`.
- `voice.mjs:1958` — comment claims "onclose handles reconnect"; the code immediately
  above explicitly does *not* reconnect.
- `deepgram-sdk-bridge.mjs:2` header refers to `deepgram-bridge.mjs`, which no longer
  exists; `voice.mjs:78` refers to a `/voice/deepgram` route the server never implements.

---

## The instrument problem — read this before debugging voice

**`vlog()` cannot record a disconnect.** It ships client log lines *over the voice
WebSocket itself* (client → bridge `msg.type === 'log'`), so any event at or after socket
close is unloggable by construction.

Measured: **0** `bridge WS closed` lines against **129** bridge-side browser disconnects.
Every `[voice]` line in `~/.config/tlda/deepgram-sdk-bridge.log` is survivorship-biased
toward a healthy socket — the file is blind at exactly the moment you care about.

Two more traps in the same file:

- **No timestamps.** Zero lines carry a date or clock. Connects cannot be aligned against
  `lag-profiles/*.json` or anything else, so time-correlation arguments are unavailable.
- **`browser connected` is not a client count.** `isBridgeUp()` probes the bridge by
  opening and closing a WebSocket, and `ensureDeepgramSdkBridge` polls it up to 24 times.
  Health-check traffic and real sessions land in the same counter.

The count that *is* trustworthy is `connected to Deepgram` — logged only on a real
upstream open.

### Recommendation

**Route `vlog()` through `src/logger.ts`.** It POSTs to `/api/log` independently of the
voice socket and timestamps every line, which fixes the blindness and the missing clock
in one change. That is the cheapest large improvement available in this area: it doesn't
fix any bug directly, it makes the next voice bug findable instead of costing someone a
night.

---

## Pattern note

Items 2 and 3 are both the **duplicate-mechanism** shape from
[`fleet-design-rules.md`](fleet-design-rules.md) — *"the replacement's references get
moved; the old thing doesn't just sit there"* — as were the reconnect bug itself and its
client-side finalize. That made **eight instances found in one night** across the
codebase. The count is itself the evidence: this is not a series of unrelated oversights,
it's the dominant way defects enter this system, and it's worth looking for first.
