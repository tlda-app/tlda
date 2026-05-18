# App Development — tlda + Fleet UI

Reference for agents working on the tlda viewer or fleet UI. Read before starting any UI/app task.

---

## HARD RULES — No Exceptions

**1. Never edit the working copy.**
`/Users/skip/work/tlda` and `/Users/skip/work/fleet` are live apps. Skip uses them constantly, including for voice mode. Any file edit triggers Vite HMR, breaks WebSocket connections, and disrupts whatever Skip is doing. **All work happens in a git worktree.** No exceptions, ever.

```bash
# Always start here — worktree goes inside the project dir, not /tmp:
git worktree add -b <branch-name> .worktrees/<short-name>
cd .worktrees/<short-name>
# then do all your work there
```

Worktrees must be inside the project directory (`.worktrees/` subdirectory). Not `/tmp`. Relative paths in `vite.config.ts` break when the worktree is in `/tmp` because macOS symlinks `/tmp → /private/tmp`, causing path resolution to fail. See `agent-guide.md` for the full workflow.

**2. Nothing merges without a tested, approved report.**
When your work is done in the worktree:
1. Test with playwright (MCP or CLI) — navigate to the worktree's dev server, interact with the UI, take screenshots
2. Write a report (see Report Format below) with flip-book screenshots showing the feature working end-to-end
3. Post the report to fleet chat and **wait for Skip to approve it**
4. Only after approval: merge to main

If you skip testing and report success — that's a lie. If you skip the approval gate — that's unauthorized. Both are unacceptable.

**3. Merging is the most dangerous operation. Treat it that way.**

The working copy (`~/work/tlda`) is Skip's live environment — it runs the viewer, the fleet coordination tools, and the agent communication system. A bad merge to main breaks the tool Skip uses to talk to the agents who would fix it. This is a circular failure with no easy recovery.

**Merge procedure:**
1. **Merge main into your worktree first** — `cd .worktrees/my-feature && git merge main`. Resolve any conflicts *in the worktree*.
2. **Test the merged result in the worktree** — run your dev server, playwright-verify, confirm nothing broke.
3. **If there are any conflicts**: stop. Tell Skip what conflicted and ask how to resolve. Do not guess. Do not "take ours." You don't know what the other changes were for.
4. **After testing + approval**: fast-forward main to the worktree branch. Main should never have a merge commit you haven't tested.

**Never do:**
- `git merge --strategy ours` or force-resolving conflicts by taking your version
- Merging directly to main without testing the merged result first
- Merging without approval
- Assuming your changes are "newer so they're correct" — the other changes may be critical infrastructure

**4. Cut first, debug second.**
Unwanted complexity causes confusion. If a component has a feature that isn't wanted and is behaving strangely, remove the unwanted feature immediately — don't spend hours tracing the bug through it. The fastest fix for a broken feature you don't want is deleting it. Grep for all references, delete everything in one pass, verify it's gone. Then if something is still broken, debug what remains.

### Worktree Hygiene

**Commit the working copy regularly.** Uncommitted changes in the working copy make worktree merges painful — you can't fast-forward, and conflicts multiply. If you've made changes to the working copy (even if you shouldn't have — see Hard Rule 1), commit them in small logical groups before starting any merge process. Don't let weeks of changes pile up.

**Check for duplicate work before starting.** Before implementing a feature in a worktree, check what's already in the working copy (`git diff` on the working copy) and other active worktrees (`ls .worktrees/`, check their branches). Two agents independently implementing URL linkification or extracting the same utility function creates merge conflicts that are entirely avoidable.

**Interactive git doesn't work.** `git add -p`, `git rebase -i`, and other interactive git commands require terminal input that Claude Code can't provide. When you need logically separate commits, plan file-level groupings. If changes to the same concern are interleaved in one file, combine them into one commit rather than trying to split hunks.

**Resolve merge conflicts with Edit/Write, not git checkout.** `git checkout --theirs/--ours` may be denied as a destructive git command. Instead: read the conflicted file, understand both sides, and write the resolution with Edit or Write. For add/add conflicts (both branches created the same file), take the superset version. For content conflicts where both sides implemented the same feature, take the version with better safety practices (e.g., `esc(url)` over raw `url`).

### Report Format

A report is a **scratch file with embedded screenshots and narrative**. The narrative proves you actually looked at the screenshots and understood what you saw. It lives in `scratch/` (e.g. `scratch/feature-name-report.md`) with screenshots alongside it (e.g. `scratch/feature-name-1-initial.png`).

**Screenshots go in `scratch/`, not `/tmp/`.** `/tmp` doesn't render in editors. Name them with the report prefix and step number: `scratch/annot-report-1-hover.png`, `scratch/annot-report-2-pinned.png`, etc.

**Structure:**

```markdown
# Feature Name — Report
**Date:** YYYY-MM-DD
**Branch:** `branch-name` worktree
**Server:** `http://localhost:PORT/?doc=DOC`

---

## Interaction Model
[Brief description of how the feature works from the user's perspective]

## What's Working (Playwright-verified)
[Numbered list of verified behaviors — what you actually tested and confirmed]

## Screenshots
[Flip-book sequence showing every step of the interaction]

### Step 1: Initial state
![Initial](feature-1-initial.png)
[What you see: describe the layout, element positions, visual state]

### Step 2: After hover
![Hover](feature-2-hover.png)
[What changed: describe the visible difference]

### Step 3: After click
![Clicked](feature-3-clicked.png)
[What happened: describe the result]

## Console Errors
[List any console errors. Categorize: expected (WS bridge), cosmetic (React warnings), or real bugs]

## Files Changed
| File | Change |
|------|--------|
| `Component.tsx` | Brief description |
```

**Flip-book means every step.** If the feature has hover → click → navigate → back → close, that's 5+ screenshots. Show what the user would see at each stage. The point is to prove you exercised the full interaction, not just that the page loads.

**Narrate what you see.** Don't just embed screenshots — describe what's in them. "The chip appears at 0.95 opacity, centered on the annotation" proves you looked. A bare `![screenshot](file.png)` proves nothing.

**Include console errors.** List them, categorize them (expected vs real), and flag any new ones your change introduced. If the page has pre-existing console errors, note them so they don't get blamed on your change.

**Good examples:** `fleet/scratch/annotation-viewer-report.md`, `fleet/scratch/filter-pills-report.md`

---

## Dev Environment

### Stable servers (working copy — do NOT edit these files)

| Service | Port | Purpose |
|---------|------|---------|
| tlda server | 5176 | Production server (Express + Yjs WS + API) |
| Vite dev | 5173 | HMR dev server for working copy, proxies to 5176 |
| Fleet server | 5199 | Fleet backend (REST API, SQLite, search, playback) — no UI |

These run from the working copy. Skip uses them. **Do not touch.**

### Agent worktree servers

Each agent works in a worktree and runs its **own** Vite dev server on a separate port. Use `tlda dev` to set up the worktree dev environment:

```bash
cd .worktrees/my-feature
tlda dev                # creates worktree, runs npm install, starts Vite, writes .dev-url
tlda dev-url            # prints the dev server URL (reads .dev-url)
```

Or manually:
```bash
cd .worktrees/my-feature
npx vite --port 5180   # pick any unused port above 5176
```

Vite will refuse to bind if the port is taken — no conflicts. **Check the Vite output for the actual port** and use it consistently in all your testing and reports. Don't assume the port — read it from the terminal output.

**When asking Skip to test something**, give the full URL with your port:
```
Please test: http://localhost:5180/?doc=bregman&token=c5e4726ab77972fc7312f3a703f9cf1c
```
Not "check the viewer" — the exact URL.

### Shared config

**Auth token:** `c5e4726ab77972fc7312f3a703f9cf1c` — append `?token=TOKEN` to URLs. Config lives in `~/.config/tlda/config.json`.

**Start tlda server:** `tlda server start` (shared across all worktrees — serves API + Yjs + assets).

**Start fleet server:** `cd ~/work/fleet && node server/server.mjs` (backend only — fleet UI lives in tlda as shapes)

## Playwright MCP

The `@playwright/mcp` server is configured globally in `~/.claude/mcp.json`. All agents have it.

**Tools are deferred.** You must load them before use:

```
ToolSearch query="playwright" max_results=5
```

This returns the schemas for `mcp__playwright__browser_navigate`, `mcp__playwright__browser_take_screenshot`, `mcp__playwright__browser_evaluate`, etc. After that they're callable.

### Key tools

- `browser_navigate(url)` — go to a URL (include auth token)
- `browser_take_screenshot(type, filename)` — screenshot viewport or element
- `browser_evaluate(function)` — run JS in the page
- `browser_snapshot()` — get accessible DOM tree (use for finding click targets)
- `browser_click(ref, element)` — click an element from snapshot

### Accessing the tldraw editor

The main tldraw editor is exposed as `window.__tldraw_editor__` (double underscores):

```js
browser_evaluate({ function: `() => {
  const editor = window.__tldraw_editor__;
  const shapes = editor.getCurrentPageShapes();
  return shapes.map(s => ({ type: s.type, id: s.id }));
}` })
```

### Typical verification flow

1. Navigate: `browser_navigate({ url: "http://localhost:5173/?doc=DOC&token=TOKEN" })`
2. Wait for load (use `browser_evaluate` with a setTimeout Promise, or check for editor)
3. Interact (set camera, click elements, evaluate JS)
4. Screenshot and read the image to verify visually
5. Check console errors via `browser_console_messages`

## Self-Service Rule

**Never tell the user to check something.** You have playwright. Use it. After making a UI change, load the page and confirm it works before reporting success.

**Always load the page after UI changes.** Page-load errors, console errors, and render failures are trivially catchable. There is no excuse for shipping them. If your change breaks page load, that's not a bug — that's negligence.

**Verify before declaring success.** Open the viewer in playwright, take a screenshot, and read it. Don't just check syntax or that the page loads — examine layout, proportions, spacing. Measure computed values if you changed sizing or positioning.

**Say exactly what you verified.** "I made the change" and "it works" are different statements. Never say the second when you mean the first. When reporting:
- **Tested and confirmed** → "Tested in playwright — page loads, button renders, click navigates correctly"
- **Made the change but can't fully test** → "Change is in. I confirmed it loads without errors. I can't test the drag interaction — need you to check that specific thing"
- **Untestable** → "Can't verify this myself. Here's exactly what to test: [specific steps]"

Claiming something works when you didn't test it is lying. It creates repeated disappointment and breach of trust. Don't do it.

**For interactions you can't test** (drag, complex gestures, multi-touch), be upfront. Don't attempt heroic workarounds for 15 minutes. State what you verified, state what you couldn't, and ask the user to check the specific untestable thing — framed as "I need you to test this" not "it's done, try it out."

**Test in WebKit.** The user views on Safari/iPad. Chromium passing doesn't mean Safari passes. Playwright supports WebKit: `playwright.webkit.launch()`.

**Debug with live tools.** Use `browser_evaluate` to inspect DOM state, computed styles, console errors. Don't guess at CSS fixes — check the actual computed values.

## Reusable Test Scripts

When you're iterating on a UI feature — fighting CSS, event handling, layout — you waste most of your time rediscovering how to test it each iteration. The fix: **extract your test procedure into a playwright-cli shell script** so subsequent iterations just run the script.

### The workflow

1. **Use playwright MCP** to interactively figure out the right test: navigate, find elements, snapshot, click, screenshot, confirm you're looking at the right thing.
2. **Once you have a working test sequence**, extract it into a `tests/verify-*.sh` script using `playwright-cli` commands.
3. **On subsequent iterations**, run the script, read the screenshots, iterate on the code.

### playwright-cli basics

`playwright-cli` is a terminal wrapper around the same playwright engine. Key commands:

```bash
playwright-cli open                    # launch browser (required first)
playwright-cli goto "http://..."       # navigate
playwright-cli snapshot --filename f   # save accessibility tree (YAML)
playwright-cli click <ref>             # click element by ref from snapshot
playwright-cli screenshot --filename f # save viewport screenshot
playwright-cli eval "() => expr"       # evaluate JS
playwright-cli console error           # get console errors
playwright-cli close                   # close browser
```

### Important: refs are dynamic

Element refs (`e51`, `e53`, etc.) change between page loads. **Never hardcode refs.** Parse the snapshot YAML to find elements by name:

```bash
playwright-cli snapshot --filename "$OUT/snap.yml" > /dev/null
REF=$(grep 'button "Notes"' "$OUT/snap.yml" | grep -o 'ref=e[0-9]*' | head -1 | cut -d= -f2)
playwright-cli click "$REF"
```

### Script template

```bash
#!/bin/bash
# Test: [what this tests]
# Usage: bash tests/verify-FEATURE.sh [doc] [token]
set -e
DOC=${1:-bregman}
TOKEN=${2:-c5e4726ab77972fc7312f3a703f9cf1c}
OUT=/tmp/playwright-test-output
mkdir -p "$OUT"

playwright-cli open > /dev/null 2>&1 || true
playwright-cli goto "http://localhost:5176/?doc=$DOC&token=$TOKEN" > /dev/null
sleep 2

# Snapshot + find refs
playwright-cli snapshot --filename "$OUT/snap.yml" > /dev/null
MY_REF=$(grep 'button "MyButton"' "$OUT/snap.yml" | grep -o 'ref=e[0-9]*' | head -1 | cut -d= -f2)

# Interact + screenshot
playwright-cli click "$MY_REF" > /dev/null
playwright-cli screenshot --filename "$OUT/result.png" > /dev/null

echo "Done. Screenshots in $OUT/"
```

### When to write a test script

- **You've tested the same interaction more than twice** — extract it
- **You're about to start an iteration loop** (change CSS → check → repeat) — write the script first
- **A feature has a known test procedure** that other agents will need — commit the script

Don't write test scripts speculatively for features that aren't being actively worked on.

## TLDraw Patterns

**Use tldraw's event system.** `stopEventPropagation` from tldraw (not bare `e.stopPropagation()`). TLDraw uses capture-phase listeners; bare stopPropagation doesn't prevent TLDraw from intercepting events.

**Shape state lives in shape props**, not in meta fields or external state. One shape = one visual unit.

**HUD shape mutations must go through the main editor.** The CanvasClipPanel (HUD) maintains a copy store that syncs with the main editor via `mergeRemoteChanges()`. Changes made through the HUD editor are marked "remote" — `@tldraw/sync` won't persist them to the Yjs server. If a HUD interaction needs to update a shape prop that must survive reload (e.g., chat filters), route the `updateShape` call through `window.__tldraw_editor__` (the main editor), not the HUD's local editor instance.

**Fleet filters use friendly names, not IDs.** Chat shape filters store agent labels and friendly names — never fleet IDs. IDs are agent-lifetime-specific and go stale when agents re-register. Friendly names are human-meaningful and stable. `agentMatchesLabel` in `fleet-data.mjs` resolves both, but filters should only contain names.

**Camera constraints:** tldraw's `zoomSteps` are multiplied by `baseZoom`, not absolute values. If `baseZoom: 'fit-x'` gives zoom 0.7, then `zoomSteps: [1, 1]` means 1x that = 0.7. `zoomSteps: [0.7, 0.7]` would give 0.7 * 0.7 = 0.49 — probably not what you want.

**Visual design is deliberately subtle.** UI chrome should be nearly invisible until hovered. Follow existing conventions: 10% opacity default, 60% on hover, 0.3s transition. Use CSS classes with `.tl-theme__dark` variants.

## No Backward Compatibility

**Do not add backward-compat shims, fallbacks, or migration layers.** When changing an API, schema, tool interface, or shape prop format — just make the breaking change. No old-param fallbacks, no "accept both formats."

## Code Principles

**One path.** If data reaches the user through two different code paths (e.g., history fetch vs live SSE), they MUST share the same filtering/processing logic. Duplicate paths = bugs.

**No silent fallbacks.** Never silently produce output from wrong input. Fail loud.

**Read before writing.** Read the files you're going to modify. Understand the existing code before changing it. If you don't understand how something works, read more code — don't guess and edit.

**Fix errors at the source.** If you hit an error from code we own — a server endpoint returning malformed output, a function throwing on valid input, a tool giving a wrong response — fix the code that produced the error. Do not add try/catch, fallback handling, or workarounds on the caller side. The bug is where the bad output was generated, not where you noticed it. Only add error handling at true system boundaries (user input, external APIs, network failures).
