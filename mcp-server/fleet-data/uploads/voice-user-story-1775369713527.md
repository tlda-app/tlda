# Voice User Story — Skip's Words (2026-04-05)

Verbatim from Skip. This is the canonical spec. Do not reinterpret.

## The user story

1. Say stuff (Right Shift toggles recording, whisper transcribes, text appears in textarea)
2. Maybe edit it (type, delete, rearrange — voice must not interfere with editing)
3. Maybe continue saying stuff (Right Shift again to resume recording)
4. Hit Enter (message sends, textarea clears)
5. Process is new again — completely clean slate, no leftover state

## Constraints

- **Latency doesn't matter.** Whisper can block for 3 seconds or whatever it needs. Skip doesn't care.
- **No buttons.** Right Shift for recording, Enter for send. Nothing else.
- **No double-tap.** Right Shift is ONLY toggle recording. Enter is ONLY send.
- **Don't eat text.** If Skip types something, it must not disappear. Ever. If whisper transcription arrives after an edit, discard it.
- **Don't duplicate text.** Transcription should never cause the same text to appear twice.
- **Don't reinsert sent text.** After Enter clears the textarea, nothing should put old text back.
- **Can wait.** You can block send. You can block recording restart. You can block typing. Whatever prevents races. Latency is fine.

## Skip's exact words

> "I just wanna say stuff. Maybe edit it. Maybe continue saying stuff. Hit enter and then have the process just be new again."

> "I don't give a shit about latency. You can wait to send. You can wait to let me type or speak again."

> "Like, whisper can block for three seconds or do whatever it needs to do. I don't give a shit."

> "It replaced my typing with (keyboard clicking)"

> "I erase it and then it just comes back"

> "It duplicated my message"

## Testing requirement

> "You guys said you have a test rig where you can play audio through shit. Presumably you can play some audio and type and hit enter and wait."

Tests MUST use real audio playback through playwright (`--use-fake-device-for-media-stream`), not mocks. Simulate the full cycle: record → transcribe → edit → enter → verify clean slate. Multiple cycles. Verify nothing reappears.

## What not to do

- Don't iterate on Skip's live browser. Test first.
- Don't reload without asking.
- Don't deploy without evidence it works end-to-end.
- Don't claim "it passes" without showing the test running.
