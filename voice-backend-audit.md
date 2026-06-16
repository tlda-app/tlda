# Voice / implicit-backend audit — tlda app

Scope: every place the app uses a backend/feature **without the user explicitly selecting it** — silent defaults, fallbacks, auto-degrades, query-param overrides. Audio/voice first (the iPad-beep class). The only thing in the whole app that produces a browser sound is `new SpeechRecognition().start()` (Chrome / iOS Web Speech), whose start/stop earcon ignores the iOS silent switch. Deepgram and whisper are silent (Deepgram's `AudioContext` is capture-only, never connected to output). So: **the beep can only come from `_backend === 'chrome'`, and every implicit path that reaches it is the bug.**

## The five implicit paths to Chrome (all now closed in the fix)

1. **Default pref was `'chrome'`** — `src/preferences.ts:20` (`'voice-backend': 'chrome'`). A user who never opened Preferences got Chrome Web Speech. **→ changed default to `''` (off).**
2. **`|| 'chrome'` hard default** — `src/voice.mjs:1655` (`getPref('voice-backend') || 'chrome'`), a second Chrome default on top of the pref. **→ removed.**
3. **Whisper-unreachable → Chrome** — `src/voice.mjs:1678,1683` (`_backend = 'chrome'` after the bridge fails / throws). User asked for whisper, silently got the beeping backend. **→ removed; unreachable now means voice off, no substitute.**
4. **Deepgram-unreachable → Chrome** — `src/voice.mjs:1716` (`_backend = 'chrome'` after the probe fails on the server host). **→ removed; same.**
5. **`?voice=` URL override** — `src/voice.mjs:1639,1653`, highest-priority selector; `?voice=chrome` forced Chrome regardless of saved choice. **→ removed entirely.**

Plus the protective-but-still-implicit iPad auto-select (`_preferProxyDeepgram`, `voice.mjs:1652`) — forced Deepgram on the iPad. Silent, so not the beep, but still implicit. **→ removed; the iPad uses only what you explicitly enabled, and if nothing is enabled, voice is OFF (never Chrome).**

## Other sound / capture surfaces (checked, safe)

- **Deepgram capture `AudioContext`** — `voice.mjs:1288`, capture-only, never connected to output; only runs when recording is already active. No sound. Safe.
- **`getUserMedia`** — `voice.mjs:820,1266,1579`. Mic access, no sound; all gated behind an active backend/recording.
- **clickDetect `AudioContext`** — `src/clickDetect.ts:271`, capture/analysis only. **This whole gesture subsystem (foot pedal / tongue-click / whistle / hiss) is removed.**
- Swept `src/`, `server/`, `bin/` for `createOscillator`, `new Audio(`, `<audio>`, `.play()`, `speechSynthesis`, `afplay`/`say`/`sox` — nothing else produces sound. Server-side bridges relay text only; they cannot make the browser beep.

## App-wide implicit defaults (no sound — lower priority, left for your call)

- `shared/config.mjs:60-65` — server URL auto-picks `https`/`http` by cert presence + `TLDA_SERVER` env override. Documented intended behavior (infra knob, not user-facing).
- `shared/config.mjs:76-79` — fleet/sync server falls through to the doc server if unset. Infra default.
- `?forcetouch` (`DocumentPanel.tsx:847`, `FleetChatShape.tsx:67`) and `?log=` — dev/testing knobs; no sound, no backend selection.

**Bottom line:** close the five paths above and route "no explicit backend" to a disabled-voice state, and the beep class is gone. That is exactly what the fix does.
