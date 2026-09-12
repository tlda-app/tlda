# Notification and liveness: what the code does {#report}

Read against `docs/notifications-and-liveness.md` at `891a70bd7`, local `main`.
Every path below was read on `main`; greps name the ref (`git grep <literal> main`),
because the shared checkout sits on whatever branch it was last left on.

Three parts, in the order they were asked for: the error states the code
distinguishes, the mechanisms that violate the spec, and a proposal.

---

## How the set was established {#the-set}

"All the mechanisms" is not satisfiable by following the two leads, so the set
was built from the system rather than from the brief. Five enumerations, each one
a closed query over `main`, not a guess at where to look:

1. **Every write into an agent's input position.** `git grep "send-keys\|sendKeys\|paste-buffer\|load-buffer" main` plus every `pty.write` under `daemon/`. Five files: `agent-launch/tmux.mjs`, `daemon/terminal-rpc.mjs`, `mcp-server/fleet-tools.mjs`, `agent-runtime/goose-kick.mjs` (via the daemon's `gooseKickSend`), `bin/fleet-daemon.mjs`.
2. **Every emitter of the `channel-notification` event.** Exactly two, both in `server/unified-server.mjs` — `:987` and `:5837`. One consumer, `mcp-server/fleet-tools.mjs:5699`.
3. **Every caller of `requestWake`.** Five: chat, delegate, amend, the timer scheduler, and the queue drain itself. Everything that notifies an agent funnels through this one function, which is why the taxonomy below is layered rather than per-feature.
4. **Every server→daemon operation.** `git grep "sendDaemonDurable(" main` — 25 call sites — against the daemon's two handler tables (`daemon/terminal-rpc.mjs:656`, `bin/fleet-daemon.mjs:1316`).
5. **Every daemon periodic job.** `git grep "setInterval" main -- bin/fleet-daemon.mjs 'daemon/*.mjs'` — nine, of which three touch agent liveness.

**What is left out, and it is a real bound.** Bots live in their own repositories
(`<name>-bot`), not in this tree, so nothing a bot does directly is in this sweep.
Bots that notify by calling `chat()` are covered, because that lands in (3); a bot
that writes to a pane itself would not be. I did not check that, and it is the
one hole I know about.

---

## Part 1 — the error and ack states the code actually distinguishes {#taxonomy}

This is the load-bearing part. The code is wrong about policy and is evidence
about taxonomy: it has met these failures and named them. Grouped by layer,
because a state is only meaningful relative to what observed it.

### L1 — the server, watching its own socket to the MCP

`attemptMcpWakeNotification`, `server/unified-server.mjs:5828`. Six outcomes:

| state | how it is established |
|---|---|
| `no-notification-text` | nothing to send; not a failure |
| `no-open-mcp-socket` | no fleet WS registered for this agent |
| `mcp-send-failed` | every `ws.send()` threw |
| `mcp-socket-closed` | all sockets closed before an ack arrived |
| `mcp-ack-timeout` | sent, socket still open, no ack within 2000 ms |
| acked | the MCP called `channel-notification-ack` |

These map almost exactly onto Skip's three symptoms — socket closed, ack failed,
acked-then-nothing — which is the evidence that this enumeration is the real one.

**The state it cannot see: a refusal.** The MCP has four paths that receive the
notice and return without acking — `data.metadata?.via === 'terminal'`,
`fromId === agentId`, an unhandled harness kind (which throws), and
`deliverChannelNotice` returning false. All four arrive at the server as
`mcp-ack-timeout`, indistinguishable from a wedged process. **There is no nack.**

### L2 — the server, deciding whether to try at all

`requestWake`, `:5910`.

| state | meaning |
|---|---|
| `missing-agent` / `dead-agent` / `human-agent` | skipped; correct, not failures |
| `pending-shell` | a reserved shell that has never logged in |
| `agent-channel-acked` | delivered, in the spec's sense of the word |
| `breaker-open` | suppressed — prior failures put this agent in backoff (5 min doubling to 2 h) |
| `queued` | handed to the daemon path |

### L3 — the queue drain

`drainWakeQueue`, `:6021`. The entry is deleted from `_wakeQueue` **before** any
of these checks, so each one below is a permanent drop, not a deferral.

| state | recorded as |
|---|---|
| agent missing / dead / human | `wake.skip` trace |
| no daemon connected at all | `wake.defer` trace, status `no-daemon` |
| **no daemon route for this agent** | **nothing at all — `continue` at `:6075`** |
| the lifecycle threw | breaker increments, `wake_failed` chat |

### L4 — the wake lifecycle

`server/lib/wake-route-lifecycle.mjs`: no fleet-daemon connected for the key;
daemon returned `ok:false` (with or without a reason — the code says so at `:66`);
the wake completed but the agent no longer has a daemon route.

### L5 — the transport underneath

`sendDaemonRpcDurableAttempt`, `:1386`.

| state | code |
|---|---|
| machine/env unresolvable, or no WS | `NO_DAEMON` |
| transient — RPC timeout, disconnected, did not reconnect | retried under a stable request id |
| retry budget spent | `RPC_DEADLINE`, and the comment at `:1419` is careful about it: *"nothing refused the op, we stopped waiting"* |
| the daemon reported an operation error | thrown immediately, not retried |

**And the state this layer cannot reach for a wake.** `sendDaemonDurable(daemonKey,
'wake', …)` passes no `rpcOptions`, so `attemptTimeoutMs` and `totalDeadlineMs` are
both `null` (`:1387-1388`), and `startWsRequest` sets no timer when `deadlineMs` is
falsy (`shared/ws-request-policy.mjs:20`). A wake attempt is bounded only by the
socket closing. A daemon holding an open socket and never replying never becomes
any state above — see §S4.

### L6 — the daemon, deciding about a process

`daemon/wake-core.mjs`. Seven distinguished conditions: no mint facts for the
identifier; not resumable (no session id **and** no launch recipe); a live process
that never joined (`:118` — no registry row, so nobody can address it); takeover
not configured on this daemon; the live process has no daemon ownership; takeover
failed to terminate the incumbent; takeover left it alive. Plus the two normal
ones: already alive, and resume attempts exhausted (`wake did not produce a live
runtime`).

### L7 — the daemon, writing to a terminal

`daemon/terminal-rpc.mjs`, `writeTextToTerminal`/`rpcNotifyAgent`: agent route
resolution unavailable; `terminal-not-ready` (prompt did not become ready inside
`ready_timeout_ms`, 90 s in practice); delivered `via: 'pty'`; delivered
`via: 'tmux'`. A throw is caught in `bin/fleet-daemon.mjs:1013` and logged; the
wake still returns ok with `notified` simply absent.

### L8 — what the server is told back, and what reads it

`notification_failure` — `{channel, reason, deadline_ms}` — is built at
`wake-route-lifecycle.mjs:51` and travels on the wake payload. Its only consumer
is `observeNotificationFailure` in `bin/fleet-daemon.mjs:995`, which writes one
`log.warn` line. **Nothing decides anything from it.** The taxonomy above is
already computed and already transmitted, and then discarded.

---

## Part 2 — the mechanisms that violate the spec {#violations}

### V1. The daemon is the notification fallback {#v1}

The spec: *"The daemon delivers no notifications. Ever."* The code, end to end:

```
requestWake (:5934) → attemptMcpWakeNotification → not acked in 2000 ms
  → _wakeQueue → drainWakeQueue (:6079)
  → runWakeRouteLifecycle{ nudgeText } → wakePayload.notify_text (wake-route-lifecycle.mjs:53)
  → daemon 'wake' → wake-core.mjs tell() (:53)
  → notifyAgent → terminal-rpc 'notify-agent' (:250)
  → tmux send-keys / paste-buffer into the agent's pane
```

This is the second delivery route, in full, and it is the primary path whenever
the channel is slow. Every notification feature in the system inherits it, because
all five of them funnel through `requestWake`.

### V2. The daemon notifies agents that already have a process {#v2}

Three branches of `wake-core.mjs` call `tell(false)` — `:124`, `:132`, `:181` —
on an agent whose process is already alive. `started` is false, so this is not a
wake in any sense: it is the daemon typing a notice at a running agent. The spec
splits `wake` from `notify` precisely so this is unrepresentable, and it is the
common case, since the fallback fires when the channel is slow rather than when
the process is gone.

### V3. The wake carries mail {#v3}

`notify_text`, `return_notice`, `notify_delay_ms`, `notify_ready_timeout_ms` and
`enter_delay_ms` all ride on the wake payload. The comment at
`bin/fleet-daemon.mjs:991` states the superseded model in so many words —
*"Wake and tell are one call, so the injection happens here rather than the server
following up"* — which is Skip's 14:05 version, replaced at 14:06 by *"the demon
just fucking wakes an agent up… and then the server is like, here are your fucking
notifications."*

The concrete thing this loses: the return notice (*"You were hibernating for three
hours"*, `agentReturnNotice`, `:1026`) has no other delivery route. Under the spec
it belongs to `login()`. Deleting the notify path without building that is the
silence the addendum warns about — see the proposal's ordering.

### V4. An out-of-band delivery carries no marker {#v4}

Skip, 14:21:23: *"make it clear that this was, like, an irregular message being
delivered by a different mechanism."* `terminalSafeNotificationText`
(`terminal-rpc.mjs:14`) flattens the text for terminal safety and adds nothing.
The only tell is the *absence* of the `<channel>` wrapper — unsearchable, and
invisible to an agent that has never heard of the convention.

### V5. Every timeout is in code {#v5}

`config/deployments/*/server.yaml` contains nothing about notifications. What
exists instead:

| value | where | what it is |
|---|---|---|
| `WAKE_MCP_ACK_DEADLINE_MS` = 2000 | `:5818`, env-overridable | **this is Skip's *x*** |
| `WAKE_BREAKER_BASE_MS` = 5 min | `:956` | backoff base |
| `WAKE_BREAKER_CAP_MS` = 2 h | `:957`, env-overridable | backoff ceiling |
| `WAKE_FAIL_WARN_MS` = 5 min | `:5817` | per-agent warning throttle |
| `wakeNotifyDelayMs` = 2000 (claude) | `:976` | post-wake settle |
| `wakeEnterDelayMs` = 400 (codex) | `:972` | keystroke settle |
| `wakeNotifyReadyTimeoutMs` = 90 000 | `:980` | prompt-ready wait |
| channel notify timeout = 1000 | `fleet-tools.mjs:1416` | MCP → harness |
| channel ack deadline = 1000 | `fleet-tools.mjs:5687` | MCP → server |

Two of them are environment variables, which the spec rules out by name alongside
source constants.

### V6. The server selects a remedy {#v6}

`restart-agent-mcp` (`:8289`) composes `kill-session` then `wake` on the server
side. That composition is the daemon's second job in the spec — *"have you tried
turning it off and turning it back on again"* — and **the daemon already
implements it**, as `rpcRestart` in `bin/fleet-daemon.mjs` (kill, verify the tmux
session is gone, `wakeMint`). Two implementations of one remedy, one on the wrong
side of the boundary.

Weaker than V1–V3, and I want to be honest about why: this path is operator-
initiated through `lifecycle()`, not the server acting on its own model. **I
checked for an autonomous version and did not find one** — nothing in this tree
sweeps agents and hibernates or restarts them on a schedule. The `hibernate`
comment at `:8256` that describes re-hibernating "every idle period forever"
refers to a caller outside this tree.

### V7. There is no report-the-symptom message {#v7}

The spec's back-off is *"this is your machine, look into it"* — a report, with the
remedy chosen by the daemon. What exists is `notification_failure` attached to a
`wake` command that already carries the text to type. The server is not reporting
a symptom; it is issuing an instruction and enclosing the payload. And per §L8
nothing reads the symptom anyway.

### V8. The ack budget is degenerate, so the duplicate is structural {#v8}

`handleChannelMessage` (`fleet-tools.mjs:5751`) awaits `deliverChannelNotice`
(≤1000 ms) and *then* `acknowledgeWakeChannelNotice` (≤1000 ms), serially. The
server's deadline is 2000 ms. **A delivery that fully succeeds at the boundary is
scored as `mcp-ack-timeout` and fires the daemon path**, so the agent gets the
notice twice — once tagged, once bare, in that order.

This is the mechanism behind Skip at 14:12: *"these synchronization failures get
worse and worse when we start going into these weird backup mechanisms."* Under
load the ack goes late more often, which fires the second path more often. Three
timeouts that must be ordered are instead exactly equal.

---

## Silent losses found on the way {#silent}

Not spec violations — but they are the shape the addendum warns about, where a
failure produces quiet instead of a wrong answer.

**S1. The reanimate return notice cannot be delivered, and the code reports that it
was.** `sendWakeNudge` (`:984`) broadcasts a `channel-notification` whose metadata
is `{type, phase, logTag, daemonKey}` — **no `wake_ack_id`**. The MCP's
`shouldDeliverChannelTurn` (`fleet-tools.mjs:5641`) returns true for a
`channel-notification` *only* if `wake_ack_id` is present. So every MCP drops it.

*Positive control, because a zero is worthless without one:* the other emitter of
the same event, `attemptMcpWakeNotification` at `:5844`, **does** set
`wake_ack_id`, and that path demonstrably surfaces. Same event name, one field
apart.

Worse, `broadcastFleet` catches its own send errors and returns nothing, so it
cannot throw — which makes `sendReanimateNoticeWithRetry`'s (`:1044`) two attempts,
its 500 ms backoff, its route refresh and its final `throw` all unreachable.
`reanimateAgent` returns `notice: noticeText` as though it landed.

**S2. `kick` is a dead wire.** `rpcKick` (`bin/fleet-daemon.mjs:742`) writes
`~/.fleet/signals/<agent_id>`. `git grep "signals" main` over the tree finds the
writer and one comment in `server/routes/fleet.mjs:973`. **No reader.** Both ends
are committed on `main`, so this is not the uncommitted-literal artifact.

**S3. A wake with no daemon route vanishes without a trace record.**
`drainWakeQueue:6074-6076` — the queue entry is already deleted, the `continue`
writes nothing, and every neighbouring branch writes a control-plane trace. This
is also the answer to the spec's open point 4 by default: nothing is recorded.

**S4. A silent daemon stops every wake in the fleet.** Per §L5 the wake RPC has no
per-attempt and no total deadline. `drainWakeQueue` awaits it with
`_wakeDraining = true`, and the caller is the unawaited `if (!_wakeDraining)
drainWakeQueue()`. A daemon that holds its socket open and never answers a wake
therefore parks the drain forever and no agent anywhere gets another notification
— the exact shape of the 2026-08-01 eighteen-hour outage the comment at `:6021`
describes, reached by a different route than the one that comment guards.

---

## The two leads {#leads}

**Lead 1 — confirmed as a mechanism; the detector needs a qualifier.** The daemon
delivering notifications by `send-keys` is real and traced end to end in §V1. But
**bare text does not by itself prove the daemon did it.** For `codex` and `goose`
harnesses the MCP types into the pane itself (`fleet-tools.mjs:5673-5675`) — that
*is* the channel, and the spec permits it explicitly (*"Or the fucking TMUX
SendText. From MCP to pane"*).

The detector is sound **only for `claude`-harness agents**, where
`deliverChannelNotice` has exactly one affordance,
`notifications/claude/channel`. For a claude agent, bare notification text in the
input position comes from the daemon's `notify-agent`, or from an operator's
`terminal(send_text)`.

I could not reproduce it in my own context: both notices I received this session
arrived tagged.

**Lead 2 — the specific claim is true; the count is low.** *No open channel and no
daemon route → accepted, no wake* is at `unified-server.mjs:7508-7513`, and the
receipt says `accepted` with reason `recipient has no daemon route`, which is the
honest mail word. Counting from the code rather than from the claim, **an ordinary
chat produces no notification thirteen ways**:

| # | where | outcome |
|---|---|---|
| 1 | `:7510` recipient is a pending shell | `accepted` |
| 2 | `:7511` no open channel **and** no daemon route | `accepted` |
| 3 | `:7517` native subagent with no direct channel | `queued`, routed to the parent |
| 4 | `:7564` no matching direct subscription | `no_direct_subscription` |
| 5 | `inbox-attention.mjs:100` policy `hold` | `queued` |
| 6 | `inbox-attention.mjs:103` policy `batch(…)` | `batched`, deferred to a timer |
| 7–9 | `:5912-5914` recipient missing / dead / human | skipped |
| 10 | `:5915` reserved shell | `pending-shell` |
| 11 | `:5952` wake breaker open | suppressed |
| 12 | `:6061` no daemon connected at all | dropped (traced) |
| 13 | `:6074` no daemon route at drain time | dropped (**untraced**, §S3) |

5 and 6 are the sender's own policy and are working as designed. 7–9 are correct.
The rest are the ones worth an argument, and 13 is a defect on any reading.

---

## Part 3 — proposal {#proposal}

The enumeration comes before the removal, because removing the sideband without
specifying what replaces it converts a wrong notification into silence. So the
order below is load-bearing, and steps 1–3 land before any deletion.

### 1. Give the notice somewhere to go that is not a wake

`login()` hands over notifications — the spec's own sequence. Today the only thing
the daemon path uniquely carries is the return notice (`agentReturnNotice`), which
means this is the whole of the rebuild: `login()` returns *"you were hibernating
for three hours"* alongside the mail it already hands over. The reanimate notice
(§S1) moves to the same place, where it will actually arrive.

**Until this exists, deleting `notify_text` loses a behaviour.** Afterwards it
loses nothing.

### 2. Make a refusal distinguishable from silence

Per §L1 the MCP has four ways to receive a notice and decline it, and all four
present to the server as a wedged process. Add a nack — the same
`channel-notification-ack` call with `{acknowledged: false, reason}` — so
`mcp-ack-timeout` stops being a bucket of five states.

This is the one *addition* proposed, and it is what makes the symptom vocabulary
below honest rather than a rename of what the server happens to be able to see.

### 3. Report the symptom; let the daemon choose

A new server→daemon message, carrying no remedy and no text:

```
notification-symptom { agent_id, symptom, observed_at, detail }
```

Symptoms, taken from §L1 rather than invented:

| symptom | the server observed | the daemon's business |
|---|---|---|
| `no-channel` | no open MCP socket for this agent | no process → make one; process → it is up with no MCP: off and on again |
| `channel-closed` | the socket closed before the ack | same question, same two answers |
| `channel-silent` | sent, socket open, no ack within *x* | a process that is not responding → off and on again |
| `channel-refused` | an explicit nack (step 2) | not a liveness fault; the daemon no-ops and the server records it |

Every one of these is idempotent on the daemon side, so the server keeps no
memory of having sent it — which is the spec's own argument, and it also disposes
of the `retry_enqueued`-shaped hazard: nothing here is a flag that must be set
exactly once.

**When there is no daemon to report to** (spec open point 4): record the symptom
against the agent and stop. No fallback, and the record is what keeps step 5 from
producing silence.

### 4. Move *x* into `server.yaml`

```yaml
notifications:
  # No ack from an agent's MCP within this long: report the symptom to its daemon.
  ackTimeout: 5s
```

Unit-bearing, per the `batch(15s)` precedent — a bare `5` is an error, not a
default. `5s` rather than today's `2s` because §V8 shows the current value is
below the MCP's own worst-case serial budget; the ordering constraint
(`ackTimeout` > MCP notify + MCP ack) is the thing to write down next to it.

Spec open point 1 (one value or per-harness) and point 2 (re-reporting) are Skip's
to settle. The code's evidence on point 1: the only per-harness numbers today are
settle delays for typing into a terminal, which this design deletes — so one value
looks sufficient once the terminal is out of the path.

### 5. Then delete the second path

In one commit, with what it takes named:

- `notify_text`, `return_notice`, `notify_delay_ms`, `notify_ready_timeout_ms`, `enter_delay_ms` off the wake payload (`wake-route-lifecycle.mjs:52-63`)
- `tell()`, `notifyAgent`, `observeNotificationFailure` out of `daemon/wake-core.mjs`
- `notifyAgent` and `observeNotificationFailure` out of `bin/fleet-daemon.mjs:995-1014`
- `'notify-agent'` and `rpcNotifyAgent` out of `daemon/terminal-rpc.mjs` — `writeTextToTerminal` stays, because `send-text` is a real operator door
- `sendWakeNudge` and `sendReanimateNoticeWithRetry` (`:984`, `:1044`) — delivering nothing today, replaced by step 1
- `rpcKick` and the `kick` route (§S2) — a dead wire, and the commit message is the record, not a test asserting it is gone

`terminalSafeNotificationText` goes with `rpcNotifyAgent`. V4 (the loud marker)
then has nothing left to mark, which is the right way for that open point to
close — but if anything is still permitted to deliver out of band while this is in
flight, it needs the marker first.

### 6. `restart-agent-mcp` calls the daemon's `restart`

Replace the server-side kill-then-wake at `:8302-8333` with one
`sendDaemonDurable(daemon_key, 'restart', …)`. The daemon's `rpcRestart` already
does exactly this and already verifies the session is gone before waking. This is
a deletion, not an addition.

### 7. Independent of all of the above: bound the wake RPC

Pass `attemptTimeoutMs`/`totalDeadlineMs` to `sendDaemonDurable(…, 'wake', …)`.
§S4 is not a notification-design question and should not wait on one — as it
stands, one silent daemon stops every notification in the fleet, and the existing
retry machinery is unreachable without a bounded attempt (the same defect, in the
same function, that `MIRROR_ATTEMPT_TIMEOUT_MS` was added to fix for mirrors).

Also fix §S3 in that pass: write a `wake.defer` trace on the no-route branch, the
way every branch beside it does.

---

## What I did not establish {#unknowns}

- **Whether any bot writes to a pane directly.** Out of tree, stated as a bound in §the-set.
- **Runtime frequency of any of this.** Everything above is read from code on `main`; I ran no measurement against a live box and none of the numbers here are observations of production behaviour.
- **Whether the `mcp-ack-timeout` bucket is dominated by refusals or by real wedges.** That is not answerable until step 2 exists, which is part of why it is step 2.
