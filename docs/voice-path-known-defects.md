# Voice path: current known defects

These defects were checked against the current voice path on 2026-07-27. This
is a defect inventory, not user guidance.

- `src/inputModes.ts` defines state that has no importers under `src/`.
- `src/voice.mjs` maintains separate voice-liveness and audio-heartbeat
  intervals that inspect the same live connection.
- Its `visibilitychange` handler can connect directly even though the module
  also has a reconnect scheduler, leaving two reconnect entry paths.
- `loadVoiceParamOverrides()` returns an empty object, while callers repeatedly
  compute and log the resulting listen options.
- `_lastTapTime`, `_singleTapTimer`, `DOUBLE_TAP_MS`, and
  `ensureDontSpeakOverlay` remain without active callers.

Repeated final segments also remain unresolved. The bridge reports Deepgram's
`speech_final`, but the client does not use that field as a state transition.
That is an observation, not a claim that `speech_final` causes the repeats.
