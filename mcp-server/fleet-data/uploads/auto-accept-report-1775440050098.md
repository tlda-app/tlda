# Auto-Accept Fix Report

**File:** `~/work/fleet/bin/fleet-spawn` line 107-113
**Change:** 1 line → 4 lines

---

## Problem

`fleet-spawn` sent one `Enter` after 3s to auto-accept the startup prompt. But Claude Code shows **two** sequential prompts:

1. **Trust prompt** (~2s after spawn): "Is this a project you trust?"
2. **Channels prompt** (~1s after trust accept): "Loading development channels"

The single Enter at 3s accepted the trust prompt, but the channels prompt appeared ~1s later with nobody to press Enter. Skip had to manually accept it.

## Fix

Changed `tmux_start()` to send Enter **twice** with a 2s gap between:

```python
# Before (broken):
subprocess.Popen(f"sleep 3 && tmux send-keys -t {session} Enter", ...)

# After (working):
subprocess.Popen(
    f"sleep 3 && tmux send-keys -t {session} Enter && sleep 2 && tmux send-keys -t {session} Enter",
    ...)
```

Timeline: spawn → 3s → Enter (trust) → 2s → Enter (channels) → agent starts at ~5s total.

## Test evidence

Spawned a fresh agent with `fleet-spawn --fresh autoaccept-test --no-attach --cwd /tmp`:

```
fleet-autoaccept-test (fleet:e4c57179) spawned in /tmp
Spawn returned, waiting for auto-accept...
1s: waiting...
2s: still at a prompt...
3s: still at a prompt...
4s: AGENT STARTED SUCCESSFULLY — prompt visible
```

Agent reached the Claude Code `❯` prompt at 4s with zero manual intervention. Both prompts were auto-accepted.

Test agent cleaned up afterward (tmux killed, fleet kicked).
