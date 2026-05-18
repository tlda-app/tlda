# roll_call Enhancement Spec

## Problem

`roll_call` tells managers which agents are alive but not what they're doing. A manager seeing:

```
Alive (4):
  pb (fleet:ed81d795) — tmux:fleet-pb, cwd: /Users/skip/work/tlda, seen 68s ago
  ui-lead (fleet:04a892ff) — tmux:fleet-ui-lead, cwd: /Users/skip/work/tlda, seen 0s ago
```

...has no idea whether pb is idle, actively working, blocked on approval, or churning. To find out, they need to call `task_list()` separately and cross-reference, then maybe `task_check()` on individual agents. That's three round-trips minimum to answer "who's doing what?"

## What roll_call should surface

For each alive/stale agent, add:

| Field | Source | Example |
|-------|--------|---------|
| `current_task` | tasks table — active task for this agent | `"Fix image patching for biometrika class"` |
| `task_status` | tasks table — status field | `"in_progress"` / `"blocked"` / `"pending_review"` |
| `last_activity` | Last tool call timestamp (from heartbeat/session) | `"2m ago"` |
| `idle` | Boolean: alive but no task and no recent tool calls | `true` / `false` |
| `unread_messages` | Count of unread chat messages in inbox | `2` |

### Example output (enhanced)

```
Alive (4):
  pb (fleet:ed81d795) — tmux:fleet-pb, cwd: /Users/skip/work/tlda, seen 68s ago
    Task: Fix image patching for biometrika class [in_progress]
    
  ui-lead (fleet:04a892ff) — tmux:fleet-ui-lead, cwd: /Users/skip/work/tlda, seen 0s ago
    Task: Resizable viewer panels [pending_review]
    1 unread message

  guidance (fleet:4388a00b) — tmux:fleet-guidance, cwd: /Users/skip/work/tlda, seen 0s ago
    No task (idle)

  controls (fleet:06e86213) — tmux:fleet-controls, cwd: /Users/skip/work/fleet, seen 733s ago
    Task: Filter chip hover content [blocked] — waiting on: fleet:04a892ff
```

### What this enables

- **"Who needs work?"** — filter on `idle: true`
- **"Who's blocked?"** — filter on `task_status: "blocked"`
- **"Is anyone waiting on me?"** — check `unread_messages > 0`
- **"What's the fleet doing right now?"** — single call replaces `roll_call` + `task_list` + N × `task_check`

## Data sources

All the data already exists:

- **current_task / task_status**: JOIN against the tasks table on agent ID. The tasks table already has `description`, `status`, `assigned_to`.
- **idle**: `alive && no active task && last_seen > 60s` (or some threshold)
- **unread_messages**: COUNT of messages in the messages table where `recipient = agent_id AND read = false`
- **last_activity**: Already have `last_seen` from heartbeat — could optionally surface the last tool name from the session log, but `last_seen` is sufficient.

## Implementation notes

- The dashboard server handler at `~/work/fleet/dashboard/server.mjs:2695` already queries the agents table and scans tmux. The enhancement is a JOIN against tasks + a count query against messages.
- The MCP handler at `~/work/fleet/index.mjs:3389` just formats the dashboard response into text. Update the formatter to include the new fields.
- Keep the current output format for dead agents (no task info needed — they're dead).
- For the JSON API response, add the fields to each agent object. Don't break the existing schema — new fields are additive.

## Optional: `--brief` flag

For managers who just want the high-level picture:

```
4 alive: 2 working, 1 reviewing, 1 idle
1 stale: controls (12m)
```

Low priority — the full output is fine for now.
