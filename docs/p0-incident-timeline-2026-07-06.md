# P0 Fleet Delivery Drop Incident Timeline, 2026-07-06

Scope: bounded first pass for the release P0 item, based on the fleet thread
surface rather than local database inspection. This does not claim final root
cause. It classifies the live incidents that were visible in the fleet thread
and records the fields still missing from the instrumentation.

Primary thread anchors:
- `strike-lead` thread, 2026-07-06 05:16-08:01.
- `releast` thread, 2026-07-06 07:09-07:56.

## Classification Set

- `memory-pressure / OOM-correlated`: low free memory coincides with agent death,
  daemon flap, or delivery loss.
- `daemon reconnect / WS flap`: daemon disconnect or reconnect interrupts spawn,
  task delivery, or mailbox reporting.
- `spawn-prompt delivery gap`: agent registers but the prompt-carried initial
  task does not arrive; chat delivery works as containment.
- `spawn+delegate persistence gap`: task is written only after attach/liveness,
  so an attach gap can lose the task.
- `codex identity/resume gap`: Codex session data exists, but the fleet-id index
  is null or malformed, so wake/resume cannot locate the rollout.
- `duplicate daemon/env contention`: more than one daemon watches the same
  environment.
- `hibernation-kill red herring`: investigated claim that hibernation detection
  was killing live agents; superseded by later trace.
- `unknown`: required close/boot/operation fields are not present in the thread.

## Incident Timeline

| Time | Source anchor | Observed symptom | Close type / code | Boot ids | Operation in flight | Machine/env | Memory | Classification | Confidence | Missing fields / next read |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 05:19 | `strike-lead -> skip` | Hibernation kill-switch verified live; exactly one daemon running. | None. Baseline, not a close. | Daemon pid 928; boot id not reported. | Fleet recovery after daemon restart. | Mini / live fleet. | Not reported. | Singleton baseline; not duplicate-daemon. | High for "one daemon" at this point; thread reports direct command proof. | Persist daemon boot id and config name in health reports. |
| 05:32 | `fleet:tlda -> strike-lead` | Spawn/wake of `releast` failed: session resolution could not locate existing Codex rollout. | Not a WS close. Resolver miss. | Not reported. | Wake existing Codex agent `fleet:c16d9c53`. | Live fleet. | Not reported. | Codex identity/resume gap. | High for symptom; root cause later confirmed as null/malformed `fleet_id`. | Include session identity record id and resolver query key in failure card. |
| 05:40-05:44 | `strike-lead -> skip`, `strike-lead -> releast` | `releast` recovered on real rollout after migration; 11/11 Codex records recovered from registration markers. | None. Recovery. | Daemon restarted through launchd; boot id not reported. | One-time Codex fleet-id migration and wake. | Live fleet. | Not reported. | Codex identity/resume gap resolved for existing records; durable write still pending. | High for recovery surface because `releast` replied on real session. | Record migration artifact path/checksum and daemon boot id in gate note. |
| 05:48-05:58 | `skip <-> strike-lead` | Hibernation detection vs actual process killing traced. Detection only marks hibernating; separate 20-min idle server loop is the killer and matches Skip's model. | None. Investigation. | Not reported. | Hibernation-liveness trace. | Live fleet. | Not reported. | Hibernation-kill red herring. | High for superseding classification in thread. | Code/file anchors were cited in chat by line; preserve in a formal doc if this reopens. |
| 06:28 | `fleet:tlda -> strike-lead` | Spawn mailbox for `cli-verbs-rename` failed: `daemon disconnected`. | Daemon disconnected; no close code/reason. | Not reported. | Spawn `cli-verbs-rename`. | Mini / live fleet. | Not reported at that exact timestamp. | Daemon reconnect / WS flap. | High for symptom; medium for cause until correlated with memory messages. | Capture daemon WS close event with code/reason, daemon boot id, server boot id, request id. |
| 06:32-06:33 | `strike-lead -> cli-verbs-rename`, `strike-lead -> delegate-durable-fix` | Spawn task did not reach two spawned implementers; strike-lead re-sent tasks via chat. | Prior daemon flap; no code/reason. | Not reported. | Spawn prompt initial task delivery for `cli-verbs-rename` and `delegate-durable-fix`. | Mini / live fleet. | 0.8 GB free / 17 GB reported at 06:33. | Spawn-prompt delivery gap; daemon WS flap; memory-pressure-correlated. | High that task delivery dropped; medium that memory pressure is causal from thread alone. | Add mailbox request id to spawn prompt delivery, and persist prompt-delivery ack status separately from registration. |
| 06:33 | `strike-lead -> releast` | Corrected strategy from fanout to bounded queue. Reported Mini had 0.8 GB free / 17 GB, 2.5 GB compressed; daemon had flapped; one implementer died with no clean exit; two registered without spawn task. | Daemon WS flap; no close code/reason. | Not reported. | Multi-agent staffing under load. | Mini / live fleet. | 0.8 GB free / 17 GB; 2.5 GB compressed. | Memory-pressure / OOM-correlated plus spawn-prompt delivery gap. | Medium-high: direct reliability-lead observation, but not raw daemon/vm_stat output in thread. | Need raw daemon log lines, `vm_stat` output, agent process exit evidence, and close metadata. |
| 06:36 | `strike-lead -> releast` | Memory worsened to 0.1 GB free; durable-write implementer died with no clean exit. Strike-lead ordered total concurrency hold. | No close code/reason reported in this message. | Not reported. | Durable-write implementer running under load. | Mini / live fleet. | 0.1 GB free / 17 GB. | Memory-pressure / OOM-correlated agent death. | Medium-high: direct live observation; no raw process-exit artifact in thread. | Cross-check spawn crash artifact once P0.3 is merged; log RSS/free memory into lifecycle events. |
| 06:42 | `delegate-durable-fix -> strike-lead` | Spawn+delegate durable fix reproduced pre-fix loss: pending delegate failed with `agent not found`; after fix task row exists before registration and drains after registration. Sandbox proof also confirmed only the main daemon remained after sandbox stop. | Not a close; persistence bug. | Sandbox server/daemon boot ids not reported. | Spawn+delegate with pending agent id. | Sandbox then main daemon check. | Not reported. | Spawn+delegate persistence gap; singleton re-check. | High for persistence bug and fix proof; not direct P0 drop cause. | Record sandbox request ids and daemon boot ids in future regression output. |
| 06:45 | `strike-lead -> releast` | After standing down one completed worker, memory jumped from 0.1 GB to 3.1 GB free. | None. Recovery after process kill. | Not reported. | Kill-on-done after `delegate-durable-fix`. | Mini / live fleet. | 0.1 -> 3.1 GB free. | Memory-pressure containment evidence. | High for queue policy; medium for exact measurement without raw command output. | Automate per-agent memory accounting enough to identify reclaimable worker cost. |
| 07:02 | `fleet:tlda -> strike-lead` | Spawn mailbox for `releast` failed again: existing Codex rollout could not be located. | Not a WS close. Resolver miss. | Not reported. | Wake existing Codex `releast`. | Live fleet. | Not reported. | Codex identity/resume gap persists until durable-write branch lands; malformed/null id still possible live. | High for symptom. | Need post-migration record diff: whether `fleet_id` was null, malformed literal `fleet:`, or another key. |
| 07:10 | `strike-lead -> releast` | Strike-lead states live daemon corrupts Codex `fleet_id` on resume; durable-write fix staged but not live. | Not a close. Causal statement from reliability lead. | Not reported. | Codex resume. | Live fleet. | Memory fragility noted. | Codex identity/resume gap. | Medium-high; branch/test evidence lives in durable-write worktree, not this report. | Merge/restart gate must verify no new corrupted Codex `fleet_id` records after daemon restart. |
| 07:23 | `strike-lead -> releast` | P1 delivery bug summarized: 3 of 4 Codex spawns booted with empty inbox; workaround is post-spawn chat. | No close code/reason. | Not reported. | Spawn prompt initial task delivery. | Live fleet. | Not reported. | Spawn-prompt delivery gap. | Medium-high: direct report, but raw per-spawn records not in thread. | Add a regression that distinguishes registration success from prompt/task delivery success. |
| 07:34 | `strike-lead -> releast` | Memory reported around 0.7 GB free; releast instructed to keep to one worker. | None. Health state. | Not reported. | Bounded worker queue. | Mini / live fleet. | ~0.7 GB free. | Memory-pressure constraint. | Medium-high from live coordinator report. | Use a standard fleet health card with raw command output. |
| 07:56 | `strike-lead -> releast` | P0 request: build WS close/restart timeline. Lead summarizes measured evidence: 0.1-1.0 GB free / 17 GB; Codex agent died with no clean exit; daemon WS flap under load dropped spawn-task delivery live. | Daemon WS flap; close code/reason not captured in thread. | Not reported. | Spawn-task delivery under load. | Mini / live fleet. | 0.1-1.0 GB free / 17 GB. | Memory-pressure / OOM-correlated daemon WS flap and delivery drop. | Medium-high as synthesized lead report; this report separates it from raw-command proof. | Pull daemon log close lines and any boot ids once instrumentation/ops lane can safely inspect the authoritative logs. |

## Findings

1. The live P0 incident class is not "raw WebSocket" alone. The strongest
   observed cluster is: memory pressure on the Mini, agent process death without
   clean exit, daemon disconnect/WS flap, and spawn-prompt task loss.

2. Queueing is containment, not root cause. The bounded queue has live support:
   when one completed worker was stopped, reported free memory recovered from
   0.1 GB to 3.1 GB. That explains why bounded concurrency plus kill-on-done is
   required while the root cause is still open.

3. There are at least three separate delivery/resume mechanisms that were easy
   to conflate:
   - spawn prompt initial task delivery can drop while registration succeeds;
   - spawn+delegate used to fail to persist a task before registration/attach;
   - Codex wake/resume can fail because the fleet-id index is wrong even though
     the rollout still exists.

4. The hibernation-kill scare is superseded. The thread trace says the disabled
   liveness sweep mislabels status, while the actual process-kill path is the
   guarded 20-minute idle server loop. Do not spend P0 effort treating
   hibernation detection as the live-kill mechanism unless new evidence appears.

5. Duplicate-daemon contention was checked at least twice in the thread: exactly
   one daemon at 05:19, and only the main daemon after the sandbox proof at
   06:42. That does not prove duplicate daemons never contributed earlier, but
   it keeps this 06:28-07:56 cluster from being classified that way without new
   evidence.

## Missing Instrumentation

The table cannot yet satisfy the full evidence gate because the fleet-visible
events do not carry enough close/restart metadata. The next implementation
slice should make these fields first-class in daemon/server lifecycle events:

1. WebSocket close type, code, reason, and whether it came from server, daemon,
   network, heartbeat timeout, deploy/restart, or process death.
2. Server boot id, daemon boot id, config name, machine id, and environment key
   on every spawn/mailbox/delegate failure card.
3. Spawn request id and mailbox id threaded through registration, prompt
   delivery, chat-delivered fallback, and task acknowledgement.
4. Memory snapshot on worker spawn, daemon reconnect, agent process exit, and
   kill-on-done.
5. Final process status for fast-dead agents: exit code, signal, stderr tail,
   and retained pane path. The verified P0.3 crash-forensics slice is the
   storage side of this; the incident cards still need to point at it.

## Immediate Operating Rule From This Timeline

Until the daemon close/restart cause is instrumented and fixed, run fleet
release work as a bounded queue across lanes: two to three workers total on the
Mini, verify a real reply and working pane before counting a worker, deliver
tasks by chat after spawn, commit frequently, and stop completed workers
immediately to reclaim memory. This is containment for the observed
memory-pressure/flap cluster, not a root-cause fix.
