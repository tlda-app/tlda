# Auto-Accept Fix Report

**File:** `~/work/fleet/bin/fleet-spawn` line 107-120
**Change:** blind `sleep && send-keys` → smart polling loop

---

## Problem

`fleet-spawn` sent one `Enter` after 3s to auto-accept the startup prompt. But Claude Code shows **two** sequential prompts:

1. **Trust prompt** (~2s after spawn): "Is this a project you trust?"
2. **Channels prompt** (~1s after trust accept): "Loading development channels"

The single Enter at 3s accepted the trust prompt, but the channels prompt appeared ~1s later with nobody to press Enter. Skip had to manually accept it.

## Fix (v2 — smart detection)

Replaced the blind `sleep 3 && send Enter` with a polling loop that uses `tmux capture-pane` to detect prompts as they appear:

```python
auto_accept_script = f'''
for i in $(seq 1 60); do
  sleep 0.5
  pane=$(tmux capture-pane -t {session} -p 2>/dev/null) || break
  if echo "$pane" | grep -q "Enter to confirm"; then
    tmux send-keys -t {session} Enter
  elif printf '%s' "$pane" | grep -q '❯'; then
    break
  fi
done
'''
subprocess.Popen(["bash", "-c", auto_accept_script], ...)
```

**How it works:**
- Polls every 0.5s (up to 30s timeout)
- When "Enter to confirm" appears → sends Enter
- When `❯` appears → agent started, loop exits
- Works for any number of prompts, any timing
- No wasted sleep — reacts as fast as the prompts render

## Test evidence

Spawned a fresh agent with `fleet-spawn --fresh autoaccept-test2 --no-attach --cwd /tmp`:

```
fleet-autoaccept-test2 (fleet:ee02f22d) spawned in /tmp
Spawn returned, monitoring...
1s: waiting...
2s: AGENT STARTED — no manual intervention needed
```

Agent reached the `❯` prompt at **2s** — faster than the old sleep-based approach (4-5s) because prompts are accepted immediately when detected.

Test agent cleaned up afterward (tmux killed, fleet kicked).
