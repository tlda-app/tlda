# PWA notifications (SPA web notifications)

His words: would make it even more likely i see it, meant to be done. Verified absent (no Notification API/SW/PushManager). spa-notify launch-stuck; re-mint after shed. Owner: none.

Status: LANDED on main 2026-09-27 (spa-notify-jr): new hud/list items raise a real Notification; no service worker, no preferences surface. Verified headed via tlda-dev pw against testing.

---

# Drag chip to canvas (docviewer)

Owner: drag-chip (fleet:ba60875b). Task: fleet:ba60-mujyofab from chief-apprentice.

## Build target (Skip's words, recovered 9/27 from fleet history)

Current form is the docviewer variant — Skip 9/27 to chief-apprentice, answering
"the 3/30 chat-to-bare-canvas form, the 8/21 docviewer variant, or both?": "2 docviewer".

Detailed spec — Skip 8/23 to bhief-4:
- "drag a markdown chip, drop it on the blank canvas"
- "it creats a docview shape pointed at the file in question"
- "that lives on the hud"
- "same as clicking + (docview placement+camera setting)"
- "chip drag should be literally the same as label drag but docview instead of chat"

Earlier forms (superseded, not the build target):
- 3/30 to apps (x2): "when you drag off the chat, it should become a doc sized
  preview" / "not off chat, like off the hud" + evaporate model (chat input =
  chip token, past HUD = inline-doc on canvas, release in HUD = cancel).
- 8/20 to bhief-sol: "drag-a-markdown-chip-to-the-hud-to-get-a-docviewshape-pointed-at-it".
- 8/21 to bhief-sol: "the drag-chip-to-canvas docviewer thing uh / did that ever
  happen?" — told it was 31e3ecbd9 (merged bc948deec); Skip tested live: "i get
  a big ghost but nothing when i put it down" + error card "that file didn't
  open. nothing wa[s] lost". Implemented-and-broken at that time.
- Flagged missing 9/26 ("you're missing fucking drag chip to canvas, which
  hopefully you can look up better than this shit; last discussed idk earlier
  this week") and 9/27 ("drag md report to canvas ... i temmeber soecifyinh",
  then "drag chip to canvas is not urgent / i am just fucking pissed it keeps
  fslling off the list").

## Existence check (code on main, before any edit)

- 31e3ecbd9 "Create docview for dragged markdown chips" + merge bc948deec: on main.
- 5e67afccb "Say the markdown chip click landed, and drag the doc viewer it opens": on main.
- 2ee5f5672 (9/18) "Show the dragged Markdown, and drop its doc view where a
  label drop puts a chat" (Skip: "place it like the fking label drop places the
  chat"): on main. No changes to the chip drop path since 9/18.
- Drop path present: FleetChatShape drag-start (ref-chip/md-file-card,
  markdownChip meta) -> FleetPillShape dropPillOnTarget ->
  createMarkdownDocviewShapeFromPill -> materialize + fleet-docview at drop
  page point. Doc-viewer ghost present.
- Verdict pending headed repro: implemented-and-broken vs missing.

## Plan

1. Headed repro on main tip: drag md chip from chat toward canvas, watch.
2. Fix root cause; typecheck; keep/extend tests/markdown-drop-docview coverage.
3. Verify headed on same surface; land via rebase + CAS update-ref
   (confirm with git cherry); deploy testing; verify /api/build-info at own sha.
4. Report rung per behavior (implemented/type-checked/deployed/watched) to
   chief-apprentice. No fix counts; report what the app was watched doing.

Status: IN PROGRESS (existence check code-side done; headed repro next).
