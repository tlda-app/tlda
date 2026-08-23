# Notifications and liveness

This is the system design document for how a message reaches an agent, and for
what happens when it does not.

It did not exist. That is why the two rules it contains were stranded in
[Fleet agent guide](fleet-agents.md) — a document about how to behave in the
system, not how the system is built — and why every agent that needed the design
reconstructed it from the code instead. The code contradicts it.

Skip, 2026-08-22 14:24 EDT, on where this does not go:

> Fleet Agents is supposed to be the fucking community. Behavior document,

> It is not a system design document,

> But, yes, it should get the fucking words straight. But, also, it's not the
> fucking design document for the fucking system,

So `fleet-agents.md` keeps its job and gets its vocabulary corrected against this
document. It does not absorb this one.

**Everything normative below is Skip's, dictated in chat on 2026-08-22 between
14:00 and 14:27 EDT, quoted with its timestamp.** Where something is open, this
document says so rather than inventing the answer.

## The two words, and they are not the same word

Skip, 14:00:12 EDT, correcting the vocabulary before anything else:

> Too weak means to take an agent who does not have a process right, who is does
> not have a running process on this machine. And start up a fucking process that
> they live in,

| word | means |
|---|---|
| **wake** | The agent has **no running process on this machine**. Something starts a process for them to live in. |
| **notify** | A notice is put in front of an agent that **already has a process**. |

**An agent with a process cannot be woken. It can only be notified.** An agent
without one cannot be notified — there is nothing to notify.

This is not a fine distinction. Collapsing the two is what produced the line in
`fleet-agents.md:18` — *"A 📬 wake is only a preview"* — which calls a
notification a wake in the guide every agent is pointed at, and so teaches the
confusion at the exact place shared vocabulary is set.

The mail words from `AGENTS.md` are unchanged and still govern what each surface
may claim: **accepted** (the server has it), **delivered** (the recipient was
notified), **read** (the recipient fetched it). Nothing here entitles a surface
to a stronger word than it earned.

## Notification: one path, and there is no second one

Skip, 14:01:36 EDT:

> So notifications are always meant to go from the fucking server to the fucking
> MCP directly. What the MCP does with them depends on what the fucking harness
> affords. We call this a channel no matter whether it's the fucking Claude
> harness, like, channel mechanism. Or the fucking TMUX SendText. From MCP to
> pane.

```
server ──notification──▶ agent's MCP ──channel──▶ agent
```

**The server notifies the MCP directly. The MCP surfaces it by whatever the
harness affords, and that surfacing is called the channel** — the Claude harness
channel mechanism and a tmux `send-keys` into the agent's pane are the same thing
at this layer, differing only in affordance.

**The daemon is not in this path.** Skip, 14:06:23 EDT:

> Like, that's a rule. Like, why are we pushing notifications to the demon ever?
> We don't. That's a rule,

Stated as the rule it is:

> **The daemon delivers no notifications. Ever.**

## Liveness: what the daemon is for

The daemon owns machine-local process state — it is the thing that knows what
processes exist on its machine — and it has **two** jobs. Skip, 14:07:25 EDT,
correcting a read-back that had given it only the first:

> No process. Make one unresponsive process. Fucking fix it. Right? Have you
> tried turning it off and turning it back on again, basically,

| condition | daemon action |
|---|---|
| No process | **Make one** — this is a wake. |
| Process exists but is not responding | **Turn it off and on again** — hibernate, then wake. |

Both are machine-local liveness. Neither is delivery.

### A wake carries no mail, because login is where mail is handed over

Skip's first statement of this, 14:05:22 EDT, made the wake atomic with its mail:

> Ensure the demon's wake notification can indeed say, like, wake the fuck up.
> Here are your messages. Okay? But, like, that is an atomic action. If you are
> not waking a fucking agent, you are not telling them they have fucking
> messages.

He then replaced it with something simpler, 14:06:12 EDT, and **this later
version is the design**:

> So in all of this, the only time the demon delivers any fucking notifications
> or when it wakes agents. And maybe it just doesn't. Maybe the demon just
> doesn't deliver notifications. The demon just fucking wakes an agent up. And
> then the server, you know, then they log in. And the server is like, here are
> your fucking notifications. That's probably the design,

So the sequence after a wake is:

1. Daemon starts the process. It says nothing about messages.
2. The agent comes up and calls `login()`.
3. **The server** hands over the notifications.

The atomicity rule from 14:05 survives as the thing this construction makes
unrepresentable: **the daemon never tells an agent it has messages, because it
never mentions messages at all.** There is exactly one place a notification can
be lost rather than two.

## The back-off: the server reports a symptom, the daemon decides the remedy

When the notification is not acknowledged in time, the server does **not** try
another way to deliver it. It tells that agent's daemon that something is wrong
on that daemon's machine. Skip, 14:05:22 EDT:

> the fucking server sends that agent's daemon a message saying, I am not getting
> a response or whatever at this level. Like, this is your machine. Look into it.
> He is not and was never meant to be a fucking sideband communication mechanism.
> Or back off communication mechanism.

And 14:09:21 EDT, on the content of that message and the division of authority:

> And so it's the demon's business to know what fucking processes there are so
> the server doesn't need to, like, switch on fucking anything. It just needs to
> say, hey. Like, this is the response I got on my socket, which might be the
> fucking socket is closed. Or might just be a fail a failure of the MCP DAC. Or
> might be the MCP acting and then nothing fucking ever coming back. It sends
> those messages to the daemon.

**The server reports what it observed. It never selects a remedy, and it never
switches on anything.** The three symptoms he enumerated:

- the socket is closed;
- the MCP ack failed;
- the MCP acked and then nothing ever came back.

The daemon receives the symptom and decides what to do about it, from the two
jobs above. It does not deliver the notification.

### Every daemon action is idempotent, so the server need remember nothing

Skip, 14:09:21 EDT, continuing:

> And the demon's behavior is effectively it's just idempotent. Right? It's like,
> okay. Like, the process is gone. Create a process. If not, no op. Right? Or You
> know, even in a sense, hibernate and wake is idempotent. Right? Because it's
> like, nothing is lost. It's just a blip in the agent's running process.

Process gone → create one. Process there → no-op. Hibernate-and-wake loses
nothing; it is a blip in a running process, and the session survives it.

**Because repeating a daemon action is safe, the server does not have to track
whether it already reported this problem.** It reports when it sees fit and the
daemon converges. Nothing in this path needs a flag that must be set exactly
once.

### The timeout is configuration, not code

Skip, 14:26:34 EDT, the constraint he attached to the request for this document:

> We don't need some fucking epicycle on epicycle. System where the server
> decides what to do. Based on status information it's getting from the fucking
> demon. The server just fucking reports problems to the daemon when it sees fit.
> Meaning the server has some fucking time out after which it says to the daemon,
> like, I didn't get an act after x seconds. A time out that is hopefully
> specified somewhere in the fucking configuration files, not in the fucking
> code,

The rule the server runs is one line: **no ack within *x* seconds → report the
symptom to that agent's daemon.**

*x* is a **server setting**, and server settings live in `server.yaml` —
`config/deployments/<env>/server.yaml` in the repository, installed to
`~/.config/tlda/server.yaml`. It is not a constant in a source file and not an
environment variable. The precedent for that placement is in the same file's own
comments: those values *"were fly.\*.toml [env] variables until an unset one
presented as a missing feature instead of an error."*

The naming and default for *x* are not settled here; see §"What is not settled".

## Two paths are visible from inside an agent, and that is worth keeping

A notification that came through the channel arrives wrapped:

```
<channel source="tlda" event_type="channel-notification" from="">
📬 Check your inbox()...
</channel>
```

A notification delivered by tmux `send-keys` arrives as **bare text in the input
position** — untagged, as though it had been typed at the agent.

So any agent can tell which path a notification took, with no instrumentation and
no logging: it is sitting in its own context window. Under this design the second
form should never occur, which makes it a direct detector for the rule being
violated.

**Do not make the two forms look alike.** Skip, 14:20:40 EDT, then correcting his
own wording at 14:21:23 EDT:

> Oh, sorry. I didn't mean mean to make them look uniform. I meant to make it
> clear that this was, like, an irregular message being delivered by a different
> mechanism,

So an out-of-band delivery gets a **loud marker saying it arrived by the wrong
mechanism**. The tell today is an *absence* — no tag — and an absence is easy to
miss and impossible to search for. A marker works for an agent that has never
heard of the tag convention.

## What this design rules out

The negative space is the point of the epicycle constraint, so it is stated
plainly:

- **No second delivery route.** The daemon is not a sideband, a fallback, or a
  back-off channel for notifications. A failed notification is never retried by
  another mechanism.
- **No server-side model of daemon state.** The server does not track what
  processes exist, does not decide what should be restarted, and does not switch
  anything on. It reports what its socket did. This is the existing boundary in
  [Current architecture](current-main-architecture.md), applied here.
- **No remedy selection by the server.** *"This is your machine, look into it"* is
  the entire message.
- **No wake that carries mail, and no mail that arrives without a wake.** The
  daemon does not speak about messages.
- **No timeout in code.**
- **No local fallback when a daemon route is missing.** Already a core rule
  (`fleet-agents.md:108`) and unchanged: a missing route fails explicitly.

## Synchronization races are not defects

An awake agent that polls `inbox()` will sometimes read a message before its
notice lands, and then the notice arrives with nothing behind it. Skip, 14:11:10
EDT:

> I think what you're seeing is a synchronization failure. Right? It's like it's
> like you happen to check your inbox and then you got a notification. Later.
> It's not a bug. Right? There's just no way we can serialize these operations.
> They're not really under our control,

Do not build serialization for this, and do not read a stale-looking `📬` as
evidence of a delivery defect on its own. What makes it worse is the thing this
design removes. Skip, 14:12:02 EDT:

> So I think the fundamental problem, right, is, like, these synchronization
> failures get worse and worse when we start going into these weird backup
> mechanisms that are not supposed to exist. And when the server starts locking
> up, or the mini starts locking up, or anything starts locking up,

The second delivery path makes the race both more frequent and more confusing: a
late back-off delivery arrives after the channel already worked and the agent
already read the message, so the duplicate is inevitable rather than mysterious.
Load makes the ack late more often, which fires the back-off more often. Removing
the path removes the class.

## Errata: the server does not distinguish an MCP from any other socket

**The design says `server → agent's MCP → channel`. The implementation says
`server → any open /ws/fleet socket → wait for an ack`.** Nothing on the server
side establishes that the thing on the far end is an MCP, and one class of
receiver holds such a socket while having no code that could ever acknowledge a
notice.

**Measured 2026-08-22, from `fleet-daemon.testing.log`.** Of 234
`mcp-ack-timeout` wake fallbacks in six hours, **207 — 88% — were `fleet:dev`**,
a bot. The top three agents were 97%; `dev` alone ran at **30–40 per hour for
eight consecutive hours** while every other agent combined ran at 1–8.

`dev-bot.mjs` opens a `/ws/fleet` connection, so `hasOpenFleetSocketForAgent`
answers true and the wake notice is routed to it. It then contains:

| literal | `dev-bot.mjs` | `mcp-server/fleet-tools.mjs` |
|---|---|---|
| `channel-notification` | **0** | 6 |
| `wake_ack_id` | **0** | 2 |
| `channel-notification-ack` | **0** | 1 |

The right-hand column is the positive control: the greps find these where they
exist, so the zeros are the absence of an ack path rather than a bad query. **The
server therefore waits the full deadline, every ~100 seconds, indefinitely, for
an answer that has no code path to arrive by.**

**Two consequences worth carrying.**

**A bot holding a `/ws/fleet` socket is not an MCP**, and reading the fallback
counts as though it were makes the largest single generator of notification
failure on the box invisible as a category — it presents as the fleet being
slow to ack.

**And it inverts the ack-timeout tuning argument for the dominant population.**
Raising the deadline does not convert these into successes; it makes each one
take longer to reach the identical outcome. Any future measurement of ack-timeout
incidence must **count `dev` separately**, or it will re-measure this bot and
call it the fleet.

**Not fixed, deliberately.** Making the server discriminate by receiver kind, and
teaching the bot to acknowledge, are both behaviour changes rather than repairs,
and §"What is not settled" item 1 already asks whether the timeout should differ
by harness kind — which is the same question arriving from the other side.

## What is not settled

These are open, and they are Skip's or an owner's to settle rather than an
implementer's to infer.

1. **The name and default of the ack timeout** in `server.yaml`, and whether it is
   one value or differs by harness kind.
2. **Whether the server re-reports** the same symptom for the same agent on a
   later timeout, and if so how often. Idempotence on the daemon side makes
   repetition safe; it does not say whether repeating is wanted.
3. **What the loud marker on an out-of-band delivery looks like**, and whether
   anything is still permitted to deliver out of band at all while the path is
   being removed.
4. **What the server does when it has no daemon to report to** for an agent. The
   standing rule is that a missing route fails explicitly and authorizes no local
   fallback; what the server records at that moment is not stated.

5. **`chat` refuses a routeless recipient and `delegate` accepts one.** Measured
   on `a2adffdff`, two probes minutes apart against the same seat — a fixture
   with `dead: true` and no process:

   ```
   chat      → refused, loudly:  "No recipients matched: fleet:82fd355d"
                trace: chat.ingress/received, then nothing

   delegate  → accepted, silently: a task was created
                trace: delegate.ingress/received
                       broadcast.fleet-event/queued
                       fleet-store delegate.insert/stored
                       ← ends here. No wake.request. No notification.symptom.
   ```

   So a task now exists for a seat that has no process and no route: **accepted
   mail that can never become delivered**, which is what `AGENTS.md` §"A mailbox
   is not proof of reachability" rules against. Which of the two behaviours is
   right is the unsettled part — refusing loudly and queueing for a seat that may
   return are both defensible, and they are not both defensible at once for two
   verbs that do the same thing.

   **Not established, and deliberately not asserted here:** whether `delegate`
   attempts a notification for a *live* recipient at all. Only one `delegate`
   trace existed in the buffer at the time and it was the probe's, so this cannot
   distinguish a guard that fires on `dead` from a verb that never notifies
   anyone.

6. **A reserved shell that never logged in can end up `dead` while its stored
   metadata still reads `hibernating`.** Observed on that same fixture:

   ```
   dead: true                          runtime_status: dead
   metadata.shell: true                metadata.status.status: "hibernating"
   ```

   and the roster answering *"resolves to fleet:82fd355d but has no live roster
   row — known to the store, absent from the registry."* A surface reading the
   metadata reports it as hibernating; the column and the projection say dead.
   **Which of those a reader gets depends on which surface they ask**, and that
   is what makes such a seat a ghost: addressable by name, absent from the
   registry, and describable two ways.

   **What set `dead` is unknown.** The liveness trace gives only
   `reason: "agent-marked-dead"` — the projection reading a flag already set,
   never the transition. Hibernating a never-logged-in shell is a *suspect* and
   has not been shown to be the cause; establishing it needs the transition, not
   the projection. Recorded as an open question rather than a mechanism because
   §"DEATH IS A FLAG IN THE DATABASE" makes the difference between those two
   consequential: if something infers this, that is the defect, and if somebody
   set it explicitly, there is nothing here to fix.

   Related and separately worth fixing: of the two returns in `requestWake` that
   precede `attemptMcpWakeNotification`, the reserved-shell one appends a
   control-plane trace and **the `dead` one appends nothing at all**. The most
   consequential branch is the silent one, so an investigation finds no record of
   the decision that stopped the notification.

Adjacent to this and already written down: the daemon↔server durable message
protocol has its own set of unspecified states — silent ack refusal, attempt
ceilings, cross-type starvation — enumerated in
[The daemon–server durable message protocol](daemon-server-protocol.md). Those
are about the transport underneath this design, not about this design, and none
of them is resolved by it.
