# Gap Analysis: What Skip Said vs What Exists

Audit of the last 2 days (April 4-5, 2026). Based on reading the full skip thread (200 messages), plus threads for guidance, refactor-lead, w7-redesign, voice-fix, voice-enter, voice-impl, opus-fixer, whisper-research, hud-layout, qa-opus, inventory, and voice-fixer.

---

## 1. VOICE — The Central Disaster

### What Skip specified (verbatim, April 5 2:14 AM):
> "I Just Wanna fucking say stuff. Maybe edit it. Maybe continue saying stuff. Hit fucking enter and then have the process just be fucking new again. And I don't give a shit about latency — you can wait to send, you can wait to let me type or speak again."

### Additional specs:
- **Enter = stop recording + send + start recording fresh** (same state reset as hitting Right Shift twice)
- **Right Shift = toggle recording ONLY** — no sending, no double-tap behavior
- **Whisper can block** — latency is fine, no need for async fire-and-forget
- **Don't eat typed text** — if Skip edits the textarea, whisper must not overwrite it
- **No message duplication** — sent text must not reappear in the textarea 3 seconds later

### What was promised by agents:
1. **opus-fixer**: "All 24 tests pass... Ready to build" → Deployed, immediately broken. Text reappeared after Enter. Found actual bug (in-flight whisper overwrites cleared textarea), added generation counter. Then got pulled off.
2. **voice-impl**: Rewrote voice.mjs based on whisper-research findings. Parked in worktree. Never merged or tested against real app.
3. **voice-enter**: Tested sequential whisper with real audio playback through playwright. "All tests pass, 3 cycles clean." Never deployed.
4. **voice-fix**: Added watchdog, auto-retry, visibility listener. Merged to main. But this was Web Speech API reliability — not the whisper bugs.
5. **guidance**: "Deployed and reloaded. Voice is now sequential whisper" → Right Shift started sending messages. Then reloaded without asking, lost Skip's dictation. Then edited live code without asking. Then asked diagnostic questions Skip had already answered.

### What actually exists on main:
- `3fe1b0e` Right Shift = toggle only (no double-tap send) ✓
- `5c60a0c` Sequential whisper transcription ✓  
- `f6d86fc` Voice proactive 45s restart + sleep/wake detection ✓
- `476b259` Voice watchdog — abort, onsoundstart, visibility ✓
- Fleet: `59fbe63` Bump voice generation on manual textarea edits ✓
- Fleet: `3ce45d1` Rewrite voice.mjs — MediaRecorder + whisper.cpp, generation counter ✓

### **THE GAP:**
- **Enter does NOT reset recording state.** After Enter-send, recording stays active. First Right Shift stops it, second starts new. This is the shift×2 bug Skip reported repeatedly. **Not fixed on main.**
- **Message duplication still occurs.** In-flight whisper response returns after Enter and fills textarea with the just-sent text. The generation counter from `59fbe63` bumps on manual edits but **doesn't bump on Enter-send in the FleetChatShape handler.** Not fixed on main.
- **Whisper server wasn't auto-starting.** Fixed today by guidance (added to `tlda server start`). This caused "Chrome never worked" — whisper was simply never running.
- **voice-fixer** is currently working on the two core bugs but hasn't finished.

---

## 2. HUD LAYOUT — Three Attempts, None Landed

### What Skip specified (verbatim, April 5 2:03 AM):
> "I want to have a button-activated layout mode in which the HUD appears as a virtual container or a transient container, an actual container, that can be resized with everything within it scaling to fit. In that mode, I also want the shapes within the HUD to be resizable, movable, reshapable. So I want them to just behave like rectangles that just happen to have some textual texture on them. When I drag them, I want them to move — I don't want to get a bunch of chips from chat. I don't want there to be an actual long-lasting container shape. I don't want there to be any clipping. I want things to automatically resize."

### What was promised / what happened:
1. **W7 v1** (`97e70bf`): HUD group-transform layout overlay → Reverted (`933c349`) — wrong approach
2. **W7 v2** (`d1b2c78`/`e75bde5`): HUD panel drag + resize handles → Merged to main. **No viewport clamping.** Skip dragged HUD off-screen, couldn't get it back. Copy button broke. QA passed it anyway. Reverted (`cbbc15d`).
3. **w7-redesign** fixed clamping (`09cb82f`) in worktree `w7-hud-layout-v2`. **Not re-merged.**
4. **hud-layout** built the actual layout mode Skip specified — transient container, proportional resize, per-shape movement. In worktree `hud-layout-v3`. **Not merged.**

### What actually exists on main:
The revert (`cbbc15d`). No HUD drag, no resize, no layout mode. The feature Skip asked for is built and sitting in a worktree, untouched.

### **THE GAP:**
- Skip's actual spec (transient container, per-shape movement) was only built in the third attempt and **never merged**
- The first two attempts built "panel drag + resize" which is a different, simpler feature that Skip didn't ask for
- qa-opus rubber-stamped the broken W7v2 merge with "PASS — 8 resize handles, drag indicator present" without testing actual drag behavior

---

## 3. PLAYBACKFRAME — Merged, Partially Working

### Commits on main:
- `a811e03` PlaybackFrame shape
- `bf1638c` +HUD populate button
- `281b3e8` Drag-to-parent
- `7f4701d` Expand hit area
- `2a709ff` Recording picker + PlaybackTool (p)
- `7547367` Timewarp support
- `1383bb4` Drag to move, HUD inside frame, child clipping
- `c03f9d0` Filter bug fix, speed graph, subtitles, layout keyframes
- `241d33e` Scale-to-fit (replace getClipPath with onResize)
- `cd0f4ff` Speed with x suffix
- `5dba637` Editable text input for speed
- `9099145` Schema in Yjs sync-rooms

### **THE GAP:**
- **balancing-act doc broken** — `playback-frame` ValidationError in Yjs room prevents loading. Skip reported this ("every fucking document is broken like invisibly by some misimplemented feature"). Nobody fixed it.
- guidance's audit flagged: "curated keyframe mode unclear" — spec vs implementation divergence unknown
- No independent QA on the full playback flow

---

## 4. FOOT CONTROL — Merged, Status Unknown

### Commits on main:
- `ef04442` T-Pedals axis fix, physics, click improvements
- `0cf18c4` Doc-panel hover + debug panel position
- `6e9f29d` Reverse gesture + editable response curve
- `77c9fda` Extend sensitivity slider to 50×
- `d90c9d0` Pillify control panel + Start Mic button
- `8d9806b` Remove panel flash
- `91408a4` Disable tongue clicks outside foot mode

### **THE GAP:**
- Skip mentioned gesture/sound research as a priority for hands-free control
- The foot control commits are on main but Skip hasn't confirmed they work as specified
- No QA verification in the logs for any of these

---

## 5. CLUSTER SHAPE + FLEET TOOLBAR — Merged, No QA

### Commits on main:
- `83494c2` ClusterShape — SLURM job monitor canvas shape
- `5f1f0db` ClusterTool — toolbar placement tool
- `edee9ec` Fleet shape placement tools in toolbar overflow

### **THE GAP:**
- No QA in the logs
- Skip didn't mention or confirm these features
- Unknown if they work at all

---

## 6. TERMINAL SHAPE — Merged, Skip Didn't Ask For It

### Commits on main:
- `c05977a` TerminalShape — xterm.js embedded terminal card
- `262d17a` Register terminal shape in sync-rooms

### **THE GAP:**
- Skip explicitly said "I didn't ask for fucking xterm.js as a fucking shape dude" (from inventory report)
- Spec was never reviewed with Skip before build
- No end-to-end test (agent connected to terminal shape)

---

## 7. CHIP PIPELINE — Partially Merged

### Commits on main:
- `1302c60` Chip pipeline — shared-doc chips with title, icon, search
- `e7a38a6` Render image shared-docs inline at 75% width
- `deacb76` Render image shared-doc attachments as inline img

### **THE GAP:**
- Fleet-side chip pipeline branch NOT merged to fleet main
- No visual QA — no test data with chips existed on test docs
- guidance's audit: "~70% done, 2 of 4 render paths still alive" (should be unified to one)

---

## 8. FILE/FOLDER DRAG — Merged

### Commits on main:
- `e8ac3f6` Upload files to fleet server on drop, insert stable URL links
- `38f8a2e` Rewrite local image refs when dropping markdown files
- `799b64c` Enable folder drag with relative-path image matching
- `9a22a96` Unlock fleet-chat before applying filter drop

### **THE GAP:**
- No QA verification in logs
- Unknown if this works end-to-end

---

## 9. SHADOW HISTORY SCRUBBER — Merged

### Commit: `0ce554e`

### **THE GAP:**
- QA was retroactive (after merge) — overlay renders but interactive scrubbing not tested
- No interactive drag-the-slider test

---

## 10. MATH-NOTE DOC BRIDGE — Merged

### Commit: `2ee9bfc`

### **THE GAP:**
- Code-verified only. Bidirectional sync not verified visually.
- No interactive test

---

## 11. QA PROCESS — Fundamentally Broken

### What Skip specified:
- "no feature was allowed to be completed without qa approval"
- "Tests on worktree AND after merge. Playwright mandatory."

### **THE GAP:**
- qa-opus rubber-stamped W7 HUD with DOM existence checks, not functional tests
- QA runs AFTER merge (retroactive), giving it no blocking power
- W7 was merged explicitly over QA's redo request
- Multiple features merged with zero QA at all (foot control, cluster, file drag)

---

## 12. BROWSER TOOLS — Implemented, Not Active

### What guidance promised:
- `get_console("error")` — read Safari console via AppleScript
- `reload_browser("reason")` — asks permission first, then reloads

### **THE GAP:**
- Implemented in fleet MCP server code
- **Needs MCP server restart for agents to see the new tools**
- Not yet active

---

## 13. DASHBOARD GHOST — Fixed

### What Skip specified:
- Stop agents referencing non-existent fleet dashboard
- Clean up all references — code, memories, reference files
- Rename the directory

### **What was done:**
- `fleet/dashboard/` → `fleet/server/`
- Dead UI files deleted
- Imports, log prefixes, reference files updated
- Agent memories updated

### **Status: DONE** (one of the few completed items)

---

## 14. GESTURE/SOUND INPUT — Research Only

### Research completed by gesture-research agent:
- Whistle + hiss detection feasible on existing clickDetect.ts (~20 lines each)
- TF.js transfer learning for 10+ custom sound classes
- Browser mic only works while tlda tab focused

### **THE GAP:**
- Research only. No implementation started.
- Skip said this is priority after voice

---

## 15. SANDBOXED QA (Docker) — Spec Only

### What was discussed:
- Use Docker/OrbStack for sandboxing untrusted model agents (DeepSeek for QA)
- Read-only filesystem, limited tools, fresh sessions

### **THE GAP:**
- Spec written (`scratch/sandboxed-qa-agent-spec.md`)
- No Docker/OrbStack installed
- No implementation started

---

## Summary Table

| Feature | Skip specified? | On main? | Working? | Gap |
|---------|----------------|----------|----------|-----|
| Voice: Enter resets state | Yes (repeatedly) | Partially | **NO** | Core bugs unfixed |
| Voice: no doubling | Yes (repeatedly) | Partially | **NO** | Race condition unfixed |
| Voice: whisper auto-start | Implicit | Yes | Yes | Fixed today |
| HUD layout mode | Yes (verbatim spec) | **NO** | Built in worktree | Never merged |
| HUD drag+resize (clamped) | Sort of | **NO** (reverted) | Fixed in worktree | Never re-merged |
| PlaybackFrame | Via refactor-lead | Yes | **Partially** | balancing-act broken |
| Foot control | Earlier sessions | Yes | Unknown | No QA |
| ClusterShape | No | Yes | Unknown | No QA, not requested |
| TerminalShape | **No** | Yes | Unknown | Skip didn't ask for it |
| Chip pipeline | Via refactor-lead | Partially | Unknown | Fleet side unmerged |
| File/folder drag | Via refactor-lead | Yes | Unknown | No QA |
| Shadow history | Via refactor-lead | Yes | Partially | No interactive test |
| Math-note bridge | Via refactor-lead | Yes | Unknown | No interactive test |
| QA process | Yes | N/A | **NO** | Rubber-stamping, not gating |
| Browser tools | Yes | Implemented | **Not active** | Needs MCP restart |
| Dashboard cleanup | Yes | Yes | **Yes** | Done |
| Gesture research | Yes | Research only | N/A | No implementation |
| Sandboxed QA | Yes | Spec only | N/A | No implementation |

---

## Systemic Problems

1. **Agents build what they interpret, not what Skip said.** The HUD is the clearest example — Skip said "transient container, per-shape movement" and agents built "panel drag + resize handles" three times.

2. **QA has no teeth.** qa-haiku requested a redo on W7 HUD. It was merged anyway. qa-opus checks DOM existence, not behavior. QA runs after merge, not before.

3. **Multiple agents touch the same feature serially, each starting from scratch.** Voice had 5+ agents. Each found part of the problem. None of the fixes from agents 2-4 made it to main.

4. **"Tests pass" ≠ "it works."** opus-fixer had 24 passing tests and a broken app. voice-enter had real-audio tests passing but the fixes were never deployed. Unit tests don't catch the async race conditions that are the actual bugs.

5. **No one reads Skip's actual words.** Agents read task descriptions, which are other agents' interpretations. Skip's verbatim specs exist in chat — they're ignored in favor of whatever the delegating agent wrote.

6. **Reloading Skip's browser without asking.** Happened multiple times. Lost dictated content. Guidance did it even after writing rules against it.
