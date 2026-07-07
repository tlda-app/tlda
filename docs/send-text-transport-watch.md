# Watch-item: send-text transport swap (pty-leak fix, 2026-07-06)

**Status:** Deployed. Watch, don't preemptively re-engineer. If the failure mode
below shows up, this is the cause; if it doesn't, leave it alone.

## What changed

Commit `92dd9cb7` fixed a pty-fd leak by **deleting the on-demand "ephemeral
PTY" path** in the daemon's `rpcSendText` (`bin/fleet-daemon.mjs`). Before, when
an agent had no long-lived terminal-watch PTY open, `rpcSendText` spun up a
throwaway PTY to write the text. Now it falls back to `tmux send-keys`.

Why the leak couldn't be fixed with a `finally`: on macOS, node-pty's
`pty.fork()` (native, `src/unix/pty.cc`) opens the ptmx master fd and only
returns the JS handle (`term.fd`) on **success**. On `posix_spawn` failure it
throws *before* returning — so JS never receives a handle, and the fd is
orphaned in native code (empirically leaked; observed daemon at 503/511 ptmx
fds). No JS-level `finally` can close an fd it never got a reference to. The only
alternatives to removing the path would be patching/forking node-pty's native
cleanup (native rebuild) — heavier, and it wouldn't help the exhaustion loop.

## The risk Skip flagged (ground truth from experience)

`tmux send-keys` has historically been **unreliable at submitting Enter** —
text lands in the TUI input but the discrete `Enter` doesn't register, so the
message **sits un-submitted on the prompt**. Observed with the cloud-agent
reconnect workaround.

## Mitigating fact

The **Enter has always gone through `tmux send-keys 'Enter'`** — even the old
ephemeral-PTY path did `pty.write(text)` then `tmux send-keys Enter`. So this
change did **not** alter the Enter mechanism; it only changed how the *text
bytes* are delivered (PTY write → `tmux send-keys -- text`). Enter reliability is
the same as before the change.

Callers already tune the submit gap via `enter_delay_ms`: wake/task nudges pass
`400ms` for codex agents; `gooseKickSend` uses a `300ms` gap; generic
`rpcSendText` defaults to `120ms`. If Enter-submit reliability becomes an issue,
raising the default gap is the first lever.

## What send-text is used for (callers, `server/unified-server.mjs`)

- Wake / task-renudge nudges (`sendWakeNudge`, `sendTaskWakeNudge`) — codex gets
  `enter_delay_ms: 400`.
- Terminal `submit` from the web terminal (`msg.type === 'submit'`).
- Plan-approval keystrokes and reject/approve responses (`enter: false`).
- `/plan` + outline-skill nudges on the outline keyword.

## Concrete watch trigger

If agent **summaries / wake-nudges start sitting un-submitted on the prompt**
after this change, the transport swap is the suspect. First move: bump the
`enter_delay_ms` default (and/or route un-carded delivery through the same
`300ms`-gap pattern `gooseKickSend` uses). Only if that fails is restoring a PTY
transport (with a node-pty native fd-cleanup patch) warranted.
