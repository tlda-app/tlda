# reload_browser MCP Tool — Spec

## Problem

Agents constantly ask Skip to hard-reload his browser. It's one of the most frequent friction points — Skip has to stop what he's doing, find the right tab, cmd-shift-R, and report back. Agents can't do it themselves.

## Solution

A fleet MCP tool that hard-reloads Skip's Safari tab via AppleScript, gated on chat permission.

## Tool: `reload_browser`

```
reload_browser(reason: string) → { success: boolean, message: string }
```

### Behavior

1. Agent calls `reload_browser(reason: "picked up new bundle with panel fix")`
2. Tool sends a chat message to Skip: "Need to hard-reload your browser — [reason]. OK?"
3. Tool waits for Skip's reply (polls for chat response, timeout 60s)
4. If Skip says yes ("yeah", "go ahead", "ok", "do it", "sure"): execute the reload via AppleScript, return success
5. If Skip says no or timeout: return failure, agent handles accordingly

### AppleScript reload

```applescript
tell application "Safari"
    do JavaScript "location.reload(true)" in current tab of front window
end tell
```

This hard-reloads (cache-busting) the active Safari tab. Requires accessibility permissions (one-time grant).

### Alternatively: skip the permission check

If Skip finds the ask/confirm flow annoying, the tool could just do it — no permission step. The etiquette doc already says agents must request via chat first, so the permission is social, not technical. The tool just executes.

Config option: `reload_browser(reason, ask: true|false)` — default `ask: true`, Skip can set a preference.

## Implementation notes

- Add to fleet MCP server (`~/work/fleet/index.mjs`)
- AppleScript via `child_process.execSync('osascript -e "..."')`  
- Chat permission: use existing `chat()` to send the request, then poll `my_task()` for reply
- Match approval phrases: /^(yeah|yes|ok|go|sure|do it|go ahead|reload)/i
- Return the reason in the success message so the agent knows what happened

## What this replaces

| Before | After |
|--------|-------|
| Agent: "please hard reload" → Skip: stops working, cmd-shift-R, "done" → Agent: continues | Agent: `reload_browser("new bundle")` → Skip: "yeah" → reload happens |
