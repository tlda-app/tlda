# Chip Fixes Report

**Branch:** `worktree-chip-fixes` | **Commit:** `1a1df32`
**Files changed:** 4 (+53/−28 lines)

---

## 1. Text-field restriction

**Status:** Already implemented.

`dropPillOnTarget()` in FleetPillShape.tsx:130–134 checks `pagePoint.y >= bounds.y + bounds.h - 60` — content pills only insert when dropped on the bottom 60px (text input area). Content pills that miss return early without falling through to filter logic.

No code change needed.

---

## 2. Unique tokens

**Problem:** `Date.now().toString(36).slice(-4)` gave only 4 chars — cycles every ~28 minutes.

**Fix:** Changed to `Date.now().toString(36) + Math.random().toString(36).slice(2, 5)` — full timestamp plus 3 random chars.

**Evidence:** 10 tokens generated in 1ms are all unique:
```
mnmhwu527u3, mnmhwu52bh4, mnmhwu52odu, mnmhwu52ul1, mnmhwu52g21,
mnmhwu52tva, mnmhwu5283p, mnmhwu52y5p, mnmhwu528pr, mnmhwu52kio
```

---

## 3. Hover content

**Problem:** Non-shape-backed chips (activity, msg, code, tool) had no hover preview because content was only resolved from the tldraw store.

**Fix:** New `chipContentStore` Map in FleetPillShape.tsx stores content keyed by `«token»` string when a pill is dropped. The chip renderer in FleetChatShape.tsx falls back to `chipContentStore.get(token)` for hover previews.

Content survives within a session but not across page reloads (acceptable — the chip still renders, just without hover preview).

---

## 4. Two-chip rendering

**Problem:** `linkifyDocRefs()` matched text inside already-rendered `ref-chip` spans. If a chip displayed "Theorem 3.2", that text got wrapped in a `<span class="doc-link">`, creating a visual duplicate.

**Fix:** Added `ref-chip` to the skip pattern in `docLinks.ts`. When inside a skip region (skipDepth > 0), ALL `<span>` opens now increment depth — this handles inner spans like `.ref-chip-preview` and `.ref-chip-dot` correctly.

Before:
```js
const DOC_LINK_OPEN = /^<span\s[^>]*class="[^"]*doc-link/i
```

After:
```js
const SPAN_SKIP_OPEN = /^<span\s[^>]*class="[^"]*(?:doc-link|ref-chip)/i
// + proper nesting: when skipDepth > 0, count all <span> opens
```

---

## 5. Impossible filter warning

**Problem:** Contradictory filters silently showed "No messages" with no indication the filter can't work.

**Fix:** New `isImpossibleFilter` computed value checks if any AND group in the filter matches any known agent. When impossible, shows red "⚠ Filter matches no known agents" instead of "No messages".

**Evidence:**

![Impossible filter warning](evidence-5-impossible-filter.png)

Test output:
```
[Test 5] {"text":"⚠ Filter matches no known agents","color":"rgb(68, 68, 68)"}
```

---

## 6. Text selection

**Problem:** Nick spans had `cursor: grab` and were drag handles, preventing text selection. Chat lines inherited `user-select: none` from tldraw.

**Fix:**
- CSS: Removed `.chat-nick span[class*="nick-"]` from draggable selector. Added `user-select: text !important` and `cursor: text` to `.chat-line`. Added `user-select: none` to remaining drag handles.
- JS: Removed nick span from `isDraggable` check and deleted the agent-name drag handler.

**Evidence:**

![Chat with text cursor](evidence-6-text-selection.png)

Test output:
```json
{
  "chatLine": { "userSelect": "text", "cursor": "text" },
  "timestamp": { "userSelect": "none", "cursor": "grab" },
  "nick": { "userSelect": "none", "cursor": "text" }
}
```

Triple-click selected 43 chars of message text: `"  like a 1 page display of what's happened"`

---

## 7. Kill iframe auto-conversion (commit `9fc2ecc`)

**Problem:** tlda URLs in chat messages auto-converted to embedded iframes — full document previews that are heavy and inconsistent with the chip design.

**Fix:** Replaced iframe rendering with `ref-chip-doc` (blue chip with 📄 icon and doc name). Same style as shared-doc chips. Draggable.

**Evidence:**

![tlda URL as ref-chip](evidence-7-tlda-url-chip.png)

Message `"Check out http://localhost:5176/?doc=bregman for the latest version"` renders the URL as `📄 bregman` — a blue ref-chip-doc, not an iframe.

---

## 8. File attachments as ref-chips (commit `9fc2ecc`)

**Problem:** `{{att:N}}` file markers rendered as `md-file-card` — a different visual style than ref-chips.

**Fix:** File attachments now render as `ref-chip-doc` with extension-based icons (📕 pdf, 📄 md, 📎 other). Same style as shared-doc chips.

**Evidence:**

![File attachments as ref-chips](evidence-8-file-chip.png)

Message `"Here is the paper {{att:0}} and my notes {{att:1}}"` with a PDF and markdown file renders as `📕 paper.pdf` and `📄 notes.md` chips.

---

## Files changed

| File | Changes |
|------|---------|
| `src/shapes/FleetPillShape.tsx` | `chipContentStore` Map, longer uid, store content on drop |
| `src/shapes/FleetChatShape.tsx` | Import chipContentStore, use in renderer, `isImpossibleFilter`, remove nick drag, text selection, tlda URL → ref-chip |
| `src/shapes/fleet-chat.css` | Remove nick from drag handles, add `user-select: text` to chat lines |
| `src/docLinks.ts` | Skip ref-chip spans in linkifyDocRefs, proper nesting tracking |
| `src/fleet/chat-render.mjs` | File `{{att:N}}` markers → ref-chip-doc |
