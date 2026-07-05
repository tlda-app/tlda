# Agent Inbox Experience Spec

Date: 2026-07-04
Status: draft for agent review

## Goal

Design the agent-facing task and inbox experience for tlda when all traffic an
agent receives comes through the fleet app. The interface must support ordinary
workers, manager/chief-of-staff agents, reviewers, librarians, and watchdogs
without forcing them to read raw chat firehoses.

This spec describes the target agent experience, not the smallest safe
implementation slice. The target is a mode-centered operating surface: agents
message naturally, the app exposes each recipient's attention mode at the send
boundary, summaries are shaped by mode, and the inbox front page shows live
obligations instead of raw traffic. Rollout can be incremental, but the product
shape should be the full mode/inbox system.

The core shift is:

- Chat is the conversation substrate and audit trail.
- The agent-facing front page is an obligation surface.
- Read receipts are protocol state, not accidental side effects of printing a
  message body inside `inbox`.

## Long-Term Architecture

The long-term model is one fleet event universe with layered interest and
notification policies.

### Event Universe

Everything the fleet can know about is an event or can be projected into one:

- chat messages
- task assignments and task updates
- reports and review gates
- wiretapped messages
- document annotations
- source/document edits and build status
- tool activity when it matters
- lifecycle, timer, and incident events

Search, `inbox`, document monitoring, wiretap, and server wake summaries should
all evaluate over this same event universe.

### Interest Scope

An agent's interest scope is the durable-ish set of events it cares about at
all. This is broader than notifications. It is the default universe for search,
clustering, current-state inbox views, and situational context.

Typical default interest includes:

- messages to the agent;
- work owned by the agent;
- tasks or agents explicitly watched by the agent;
- document annotations/edits/build events for documents the agent is working on;
- incident or project tags the agent has joined;
- wiretap clauses the agent has added.

`monitor_add(doc)` should eventually become "add document annotation/edit/build
events for `doc` to my interest scope." Wiretap should become "add this
chat/search filter clause to my interest scope." They are not separate concepts
in the target model.

### Notification Scope

Notification scope is the subset of interest scope that should actively wake or
summarize to the agent right now. It is mode-dependent.

Examples:

- In `focus`, the interest scope may still include a document, watched agents,
  and task history, but only Skip, direct blockers, and current-task-critical
  events notify.
- In `inbox`, more of the interest scope is surfaced for triage.
- In `monitoring`, stale work, `WAITING ON ME`, report gates, and watch changes
  notify.
- In an available/bored mode, notification scope can expand to the entire
  interest scope.

### Wake On Notify

`wake on chat` is the current special case. The target primitive is
`wake on notify`:

1. An event enters the event universe.
2. The server evaluates it against the agent's interest scope.
3. If it matches the current notification scope, the server wakes/summarizes.
4. If it matches only interest scope, it remains available in `inbox` and search
   without waking.
5. If it matches neither, it is ignored unless found by ad hoc search.

Task/liveness reminders are another special case to absorb into this model.
The current "you have a pending task" nudge is useful because agents can go idle
without any natural chance to reconsider their obligations, but it is annoying
when delivered outside the agent's current attention needs.

In the target model, stale-task nudges are server-side obligation notifications:

- source event: a task remains pending/open while the agent is idle or has not
  checked its inbox recently;
- interest scope: the task is owned by this agent;
- notification scope: the current mode decides whether stale owned work should
  wake the agent now;
- view policy: summarize the concrete obligation and next action, not a generic
  nag.

Todd or another watchdog can still produce or consume these signals, but the
decision "should this wake the agent now?" belongs with the same mode-driven
notification policy as chat, wiretap, document monitoring, and incident events.

### Pierce Override

Every mode needs an explicit pierce path: "this is outside your notification
scope, but the sender asserts it should wake you anyway."

Pierce is a delivery override, not just visual styling:

- the server relays/wakes despite the current mode;
- the sender must provide a reason;
- the recipient sees that reason;
- the item is auditable;
- repeated misuse can become a manager/watchdog signal.

Pipeline:

1. Event matches notification scope -> normal wake.
2. Event matches interest scope only -> no wake, available in `inbox`/search.
3. Event outside scope with pierce -> wake anyway, with reason/audit.
4. Event outside scope without pierce -> no wake.

## Principles

1. **Obligations first.** The main surface answers "what do I need to notice,
   decide, or advance?" before it answers "what messages exist?"
2. **Cheap wake-ups, explicit hydration.** Push notifications should wake the
   agent with a compact summary. The agent should pull full context only when
   it is about to act.
3. **Receipt state is separate from handled state.** Seeing an item is not the
   same as resolving it.
4. **Mode-specific projections, shared protocol.** Focus, inbox, monitoring,
   and incident modes may show different
   summaries, but they use the same item, thread, cursor, and receipt model.
   Roles only influence default mode choices and available obligation kinds.
5. **No per-render roster thinking.** Inbox and membership sets should be
   maintained incrementally from events and read as maintained views.
6. **The UI must be voice/touch/agent friendly.** The interface should not rely
   on dense keyboard workflows or long unstructured transcripts.

## Data Model

### Event

An event is anything that may affect an agent's attention:

- chat message
- task assignment or task status change
- handoff
- blocker
- report submitted
- QA rejection or approval
- timer
- monitor/document annotation
- agent lifecycle change that matters to an owned item

Events are append-only audit records. They are not themselves the inbox UI.

### Thread

A thread is an ordered conversation or work stream. Examples:

- Skip and one agent
- manager and worker
- task thread
- handoff thread
- document annotation thread

Threads are hydrated on demand.

### Inbox Item

An inbox item is the thing the agent can act on. It may be backed by one event
or many events.

An inbox item is an obligation projection, not a new durable source of truth.
The source of truth remains events, tasks, reports, mailbox operations,
handoffs, threads, and explicit disposition records. Inbox items should be
repairable from those records.

Fields:

- `id`
- `kind`: `user-message`, `direct-agent-message`, `task`, `blocker`,
  `handoff`, `report`, `operation`, `watch`, `timer`, `annotation`
- `priority`: `interrupt`, `now`, `soon`, `background`
- `owner`: agent responsible for moving it
- `source`: sender, task id, document, or subsystem
- `summary`: one-line action-oriented summary
- `state`: `unseen`, `seen`, `active`, `snoozed`, `delegated`, `handled`
- `last_event_at`
- `last_seen_event_id`
- `next_action`: optional structured command suggestion
- `thread_ref`: pointer used by hydration calls
- `receipt_scope`: event range or thread range covered by the item

Inbox items should be maintained incrementally as events arrive. `inbox`
reads a maintained projection; it should not rediscover the world from scratch.

For async operations such as spawn/mailbox work, the item id should be the
obligation id (`mailbox_id`, task id, report id, handoff id). `thread_ref` is
only hydration/audit context. A single chat thread may contain several operation
completions, and their seen/handled state must not bleed together.

### Receipt State

Receipts have three layers:

- **Delivered cursor**: the wake-up signal reached the agent's channel or tmux
  summary.
- **Seen cursor**: the item or event range was included in a task/inbox surface
  the agent loaded.
- **Handled state**: the agent replied, delegated, snoozed, marked done, or
  otherwise resolved the obligation.

These must remain separate. A context-read can mark something seen without
making it handled. A peek can hydrate context without advancing the seen cursor.

Receipt scopes should use item ids, event ids, and explicit thread ranges.
Timestamps are display metadata, not stable protocol boundaries.

Receipts must bind to exact agent ids, not friendly names or lineage labels. A
receipt on `chief` is ambiguous after the occupant rotates; a receipt on
`fleet:<id>` is not. A queued message to a hibernating or dead agent can be
delivered to the system without being seen or acted on by that agent.

## Notification Model

### Attention Modes

Each agent should be able to register or switch an attention mode, similar to
phone Focus modes. The underlying inbox items stay the same, but the inbox
surface and pushed summaries differ by current work mode, attention budget, and
surface. Role only biases default mode choices and available obligation kinds.

A mode is an interest specification plus a view policy:

- **Interest specification**: a small chat/search-style filter expression that
  says which personal inbox items are in-bounds for this mode.
- **View policy**: how matching items are presented. This includes `inbox`
  grouping, row priority, summary shape, batching/coalescing, and what gets
  pushed immediately versus left for hydration.

`inbox` and server summarization modes must not become separate systems. They
are two surfaces using the same mode: `inbox` is the pull view, and server
summaries are the streaming push view.

Interest specifications should reuse the filter grammar agents already know from chat
and search. Do not invent a new DSL. The shared primitive is an **interest
specification**:

- search is batch evaluation over history;
- `inbox` is current-state evaluation over actionable items;
- server summaries are streaming evaluation over newly arriving events.

The base is implicitly the agent's own inbox, roughly `to:me` plus items the
agent owns or is watching. A mode interest spec is a modifier over that base.

Wiretap fits this model. A wiretap is an added scope clause for messages or
events not explicitly addressed to the agent. It should not be a separate
agent-facing feature surface. Most modes use the personal inbox base; monitoring
or incident modes may add clauses such as `to:fleet:skip`, `from:ops`,
`label:app`, or `incident:<id>`.

Wiretapped items usually enter as watch/signal rows, not direct obligations,
unless the mode policy promotes them. Seeing a wiretapped item must not advance
the original recipient's seen receipt.

The expression should define a maintained view. It must not become a per-render
roster scan, and it must use exact identity/tag semantics. Display helpers and
lineage pretty-printing must not change which agents are in scope.

Example registration shape:

```json
{
  "role": "chief-of-staff",
  "attention": {
    "mode": "monitoring",
    "interestSpec": "waiting-on:me | owned-by:me | watched-by:me | from:fleet:skip",
    "viewPolicy": {
      "inbox": "grouped-monitoring",
      "terminal": "grouped-now-with-actions",
      "channel": "compact-counts-plus-critical",
      "interrupts": ["user-message", "blocker", "process-violation"],
      "batch": "coalesce-for-30s",
      "includeSuggestedActions": true,
      "includeThreadExcerpt": false
    }
  }
}
```

Useful dynamic attention modes:

- `focus`: only user messages, direct blockers, and current-task failures
  interrupt.
- `inbox`: broad triage mode for checking the actionable queue between tasks
  or after being idle.
- `monitoring`: grouped fleet signals, stale owned work, and process exceptions.
- `incident`: ops/build/daemon failures, impacted agents, and current mitigation
  state.

Roles can provide defaults:

- a worker usually starts in `focus`;
- an idle/checking-in agent usually starts in `inbox`;
- a chief or release train usually starts in `monitoring`;
- ops usually starts in `incident` or `monitoring`;
- a librarian usually starts in a request-queue form of `inbox`.

These are defaults, not separate inbox products.

### Initial Mode Set And User Stories

Start with a small set of modes. The point is to get real behavioral contrast without
inventing a large taxonomy before agents have lived in it.

#### `focus`

For an agent doing one piece of work.

User story: As an implementer in `focus`, I get a short terminal push only when
a message changes my current task, blocks me, or comes directly from Skip.
When I call `inbox`, I see my active task, current blockers, direct questions,
and task-critical updates. I do not see fleet chatter, healthy progress from
other agents, or unrelated lifecycle noise.

Typical interest spec: `current-task | from:fleet:skip | blocker`.

#### `inbox`

For an agent checking what to do next.

User story: As an idle or between-actions agent in `inbox`, I can ask for my
actionable queue without scanning raw chat. The server can push compact counts
and the top few actionable items, but most context waits for hydration.

Typical interest spec: `to:me | owned-by:me | watched-by:me | mention:me |
handoff-to:me`.

#### `monitoring`

For an agent responsible for other agents' progress.

User story: As a release-train or chief-style agent in `monitoring`, the first
thing I see is `WAITING ON ME`: gates, approvals, routing decisions, and
blocked workers that need my action. After that I see stale delegated work,
reports needing review, blockers, and watch changes. Normal thinking/status
flicker is suppressed.

Typical interest spec: `waiting-on:me | owned-by:me | watched-by:me |
report-gate:me | from:fleet:skip`.

#### `incident`

For active breakage or urgent coordination.

User story: As ops or a manager in `incident`, normal chatter collapses behind
the active incident. Push summaries repeat impacted systems/agents, current
mitigation, owner, next decision, and any new blocker. `inbox` shows the
incident state first until it is resolved or the agent exits incident mode.

Typical interest spec: `incident:<id> | impacted-by:<id> | blocker`.

#### `available`

For an agent explicitly open to ambient work.

User story: As an agent in `available`, I want everything in my standing
interest scope to be notification-worthy. This is the "I'm bored / available"
mode: the interest scope is unchanged, but the notification scope expands to the
whole interest scope.

Typical interest spec: same as `inbox`; view policy pushes more aggressively.

#### `review`

For an agent handling reports, evidence, gates, or sign-off work.

User story: As a reviewer or release coordinator in `review`, I want reports,
QA outcomes, missing evidence, approval gates, and completed work surfaced ahead
of ordinary chat. Other inbox items can remain visible but secondary.

Typical interest spec: `report | review | qa | gate | evidence | waiting-on:me`.

The mode may be:

- chosen explicitly by the agent,
- set by task state, such as entering review mode after a report arrives,
- inferred by the app from behavior, such as suppressing background summaries
  while the agent is actively exchanging messages with Skip,
- overridden by the manager for incident or handoff situations.

### Visible Mode State

Mode should be visible to other agents before they send or route messages. It is
not only a private notification preference; it is a social protocol cue.

Examples:

```text
release-train is in monitoring mode.
Grouped status updates are welcome. Direct interruptions should be blockers,
reports needing routing, or Skip-critical issues.
```

```text
mailbox-impl is in focus mode.
Non-blocking messages will queue. To pierce focus, mark the message as a
blocker and include the reason.
```

Piercing a mode should be explicit and auditable:

- sender chooses `pierce` or `escalate`;
- sender must give a reason;
- the item becomes high priority for the recipient;
- the reason is stored on the inbox item;
- repeated misuse can be surfaced to a manager/watchdog.

This keeps genuine blockers possible without letting every ordinary message
pretend to be urgent.

The sender should not have to run a separate lookup before messaging. The normal
flow is still "message the agent you mean to message." Mode awareness appears at
send time:

```text
mailbox-impl is in focus mode.
This message will queue as normal priority.

[Send normally]  [Mark urgent...]
```

If the sender chooses urgent:

```text
Why does this pierce focus mode?
[ blocker for current task                         ]

[Send urgent]  [Cancel]
```

The urgent send creates a high-priority inbox item with the sender's reason
attached. The mode is advisory for ordinary delivery and explicit for priority
escalation; it should not block normal communication.

Delivery surfaces:

- **Terminal/tmux summary**: terse, action-oriented, safe to inject directly
  into the agent's active context.
- **Channel summary**: compact chat-visible notification, useful when the agent
  is idle or between tools.
- **Hydrated inbox**: the full `inbox`/`inbox_open()` view.

The terminal or channel summary advances the delivered cursor only. It should
not mark items seen. `autoSeen` should be omitted from v1; if it ever exists it
should be internal-only and disallowed for truncated summaries.

### Push Summary

The lightweight push that appears in the agent channel should be small and
non-hydrating.

Mockup:

```text
📬 Inbox: 3 now, 5 watch

NOW
- Skip asked you a product-design question. [user-message]
- app-tester is blocked waiting for review of report r-482. [blocker]
- chief:day handed off a stale fleet-chat issue. [handoff]

Call inbox for the obligation view.
```

For a worker with one direct task:

```text
📬 Task update

- New task assigned by Release Train: fix missed-reload badge.
- One direct message from app-tester on the same task.

Call inbox to read and acknowledge.
```

The push summary advances the delivered cursor only.

## `inbox` Surface

`inbox` replaces `my_task()`. It should return the current obligation projection
and advance the seen
cursor for the items it includes. It should not dump every raw message.

### Ordinary Worker

```text
TASK
Fix missed-reload badge
Owner: you
Manager: Release Train
State: active
Next expected: implementation + browser verification

NOW
[1] Skip asked a clarification in your thread, 2m ago
    "Does this also fix reconnect after sleep?"
    Actions: reply | open-thread | snooze 10m

[2] app-tester replied on this task, 5m ago
    "Repro still fails on default layout."
    Actions: open-thread | mark-seen

CONTEXT
- Last report was rejected: screenshot did not show reconnect case.
- Files currently in scope: src/SvgDocument.tsx, src/useYjsSync.ts.

BACKGROUND
- 4 unrelated fleet messages hidden. Use inbox_list --background to inspect.
```

### Manager / Chief Of Staff

```text
ROLE: chief-of-staff

NOW
[N1] Skip asked worker "what was the error?" and got no answer for 2m.
     Target: app-worktree-7
     Suggested action: interrupt with the unanswered question
     Actions: interrupt | open-thread | mark-handled

[N2] report r-482 is missing browser evidence.
     Target: qa-haiku -> Release Train
     Suggested action: bounce report to implementer with exact missing field
     Actions: bounce | open-report | delegate-review

[N3] ops reports fleet daemon restart on Mini.
     Scope: may affect spawned agents on that machine
     Suggested action: watch for registration failures
     Actions: watch | ask-ops | dismiss

OWNED WORK
[O1] Fleet chat filter bug
     Assignee: app-agent-12
     State: implementing, last meaningful update 11m ago
     Risk: default-layout browser verification still missing
     Actions: ask-status | open-thread | escalate

[O2] Agent inbox spec
     Assignee: you
     State: drafting, waiting for reviewer feedback
     Actions: continue | open-review-thread

WATCHLIST
[W1] chief:day hibernating but has unresolved handoff
[W2] app-tester idle while owning browser verification
[W3] two agents touched FleetChatShape.tsx in different worktrees

RECENT SIGNALS
- librarian found prior decision: exact friendly_name is identity.
- qa-chat flagged delegation-via-chat once in the last hour.
- app-agent-9 completed build, awaiting report().
```

### Librarian

```text
ROLE: app-librarian

NOW
[N1] chief asks for bounded context on fleet chat filter semantics.
     Need: source anchors and current invariant
     Actions: search-history | open-thread | reply

REQUEST QUEUE
[R1] "Where is default layout forced for tests?"
[R2] "Find old decision about no lineage-aware filtering."

WATCH
- No unanswered direct requests.
- One background mention in app channel hidden.
```

### App Tester

```text
ROLE: app-tester

NOW
[N1] Verification requested: fleet chat filter default layout.
     Required surface: browser-visible behavior
     Evidence needed: screenshot + console status
     Actions: start-test | open-task | ask-clarification

ACTIVE TESTS
[T1] Reconnect reload guard
     State: running Playwright, last output 30s ago
     Actions: view-log | mark-blocked

RECENT SIGNALS
- Implementer changed FleetChatShape.tsx.
- QA rejection asks for mobile screenshot too.
```

## Hydration Calls

The inbox surface should be small. Agents need explicit ways to pull context.

Proposed calls:

- `inbox_summary(mode?)`: compact push projection for tmux/channel summaries.
  Advances delivered only, not seen.
- `inbox`: full pull projection for the current agent. Marks included items
  seen.
- `inbox_list({ state, kind, priority, mode })`: list maintained inbox items.
  Marks listed items seen only with `ack: true`.
- `inbox_open(item_id, { ack: true })`: hydrate one item, include relevant
  thread excerpt, and mark that item seen.
- `thread_open(thread_ref, { mode: "peek" | "ack" })`: open bounded thread
  context. `peek` does not advance receipts.
- `inbox_handle(item_id, disposition)`: mark handled, delegated, snoozed, or
  blocked with reason.
- `inbox_watch(thread_ref | task_id, reason)`: add a watch item maintained by
  future events.

The important design point is not the exact names. It is that opening context,
acknowledging receipt, and resolving the obligation are separate operations.

## Mode Projections

The examples below mention common roles because they make the scenarios
concrete, but the primitive is the current attention mode.

### Deep-Work Mode

Shows:

- active task
- direct user/manager messages
- messages attached to active task
- blockers preventing the current task
- minimal background count

Hides by default:

- fleet-wide chatter
- other agents' task lifecycle
- unrelated watch signals

### Monitoring Mode

Shows:

- a top `WAITING ON ME` bucket for rows blocked on this agent's gate,
  approval, decision, or routing action
- unanswered user messages
- delegated work that is stale, blocked, rejected, or done-awaiting-next-step
- reports needing routing
- cross-agent conflicts
- infrastructure events that affect owned work
- handoffs from predecessor manager seats
- watch items whose state changed for a specific reason

Hides by default:

- raw worker chatter unless it changes an obligation
- healthy task progress
- old hibernating-agent noise unless attached to a live handoff
- generic lifecycle events with no owned work, handoff, or watch attachment
- per-thinking-edge/status flicker; milestone, blocker, report, gate, and
  handoff transitions matter, not every liveness twitch

### Watchdog Mode

Shows:

- process violations
- unanswered Skip messages
- idle agents with pending obligations
- agents about to do destructive or out-of-scope actions
- repeated pattern failures

Hides by default:

- normal implementation details
- content judgments outside process scope

### Request-Queue Mode

Shows:

- bounded context requests
- source-anchor requests
- follow-ups on prior packets
- missed questions about source/history

Hides by default:

- implementation chatter unless it asks for context

### Review Mode

Shows:

- verification requests
- reports awaiting review
- missing evidence
- test runs in progress
- browser-visible failures attached to owned tasks

Hides by default:

- task planning chatter before something is ready to test

## Handling Semantics

Recommended dispositions:

- `approve` / `gate`: clear a plan, milestone, report, or other manager gate
- `reply`: agent answered in chat
- `delegate`: assigned tracked work to another agent
- `bounce`: returned report/work with missing criteria
- `interrupt`: stopped an agent and sent corrective instruction
- `snooze`: hide until time/event
- `watch`: keep visible only on state change
- `dismiss`: no action required; leave audit trail
- `blocked`: cannot proceed; records authority boundary

Handledness should be item-level. Reading the associated thread does not handle
the item.

For a Skip message, handled means the agent sent a direct answer or explicitly
dismissed/no-actioned the obligation with a reason. "Skip has read the reply" is
a separate human receipt, not the agent's closure condition. If the answer is
bad, that creates a new rejection or follow-up item.

## Mock Interaction

### Manager receives a wake-up

```text
📬 Inbox: 2 now
- Skip question unanswered by app-agent-7 for 2m.
- report r-482 rejected by qa-haiku: missing screenshots.
```

### Manager calls `inbox`

```text
NOW
[1] Skip question unanswered by app-agent-7 for 2m
    Question: "what was the error?"
    Last agent action: running rg, no chat response
    Suggested action: interrupt and ask for direct answer
    Actions: interrupt app-agent-7 | open-thread | snooze

[2] report r-482 rejected by qa-haiku
    Missing: screenshot_after, console_errors
    Suggested action: bounce to implementer
    Actions: bounce | open-report | mark-handled
```

### Manager opens item 1

```text
inbox_open N1

ITEM N1
Skip asked app-agent-7: "what was the error?"
Elapsed: 2m14s without answer

Relevant thread:
12:01 Skip: what was the error?
12:01 agent: I'll check the logs.
12:02 agent terminal: rg ...

Suggested message:
"Skip asked what the error was. Answer that directly from what you know before
running more tools."
```

Opening the item marks it seen. It remains active until the manager interrupts,
chats, snoozes, or dismisses it.

## Implementation Sketch

1. Add an inbox-item projection fed by fleet events and durable source records.
2. Maintain per-agent views keyed by recipient, owner, mode, task, and watched
   thread. Use existing event-maintained collection patterns rather than roster
   scans.
3. Add receipt records:
   - delivered cursor per agent/channel
   - seen cursor per agent/item or explicit event/thread range
   - handled disposition per item
4. Add `inbox` as the pull projection for mode-shaped inbox items.
5. Add explicit hydration calls for item/thread opening with `peek` vs `ack`.
6. Add monitoring-mode projections after the shared model works for ordinary
   workers.

## Target Scope

The target experience includes the whole mode-centered inbox system:

1. Visible attention modes for every agent, with sender-side "send normally" vs
   "mark urgent with reason" friction.
2. Mode-shaped summaries for terminal/tmux, channel notifications, and hydrated
   inbox views.
3. Inbox items for tasks, direct user/agent messages, blockers, reports,
   handoffs, annotations, watch items, and async operation/mailbox completions.
4. Monitoring-mode surfaces with `WAITING ON ME`, `NOW`, `OWNED WORK`,
   `WATCHLIST`, and constrained `RECENT SIGNALS`.
5. `focus`, `inbox`, `monitoring`, `incident`, `available`, and `review` projections as the first
   mode set, with room to add, cut, or merge modes after agents live in them.
6. Interest specs on modes, using the same logical filter grammar as
   search/chat as a modifier over the agent's implicit personal inbox base.
7. One reusable interest-specification primitive evaluated as batch search,
   current-state `inbox`, or streaming server summaries.
8. First-class row actions: reply, open-thread, peek, ask-status, approve/gate,
   delegate, bounce, interrupt, snooze, watch, mark-blocked, dismiss, retry, and
   continue-after-completion.
9. Delivered/seen/handled receipts scoped by item ids, event ids, explicit
   thread ranges, and exact agent ids.
10. Maintained views for membership/watch sets, with no roster scans and no
   generic lifecycle firehose.

## Validation Posture

The slow part is agent-experience validation, not basic implementation. Do not
spend the first testing cycle on a tiny protocol slice that no agent would
actually want to use.

Modes are cheap experiments over the same obligation substrate. Do not treat the
initial mode taxonomy as sacred. Implement several plausible modes, including
small variants that differ only in summary verbosity, urgency thresholds, or
default buckets. Let agents live in them, then cut, merge, or rename the modes
they do not use.

The first prototype should feel like the target product even if some backing
mechanics are stubbed. It should let real agents experience:

- setting or being assigned an attention mode;
- visible recipient mode state at send time;
- normal send vs urgent/pierce with a required reason;
- mode-shaped push summaries;
- a hydrated obligation inbox;
- `WAITING ON ME` for monitoring-mode managers;
- watchlist/signal rows that only appear when they change an obligation;
- explicit handled/snooze/delegate/bounce/approve actions.

Testing should answer whether agents can manage work through the surface without
falling back to raw chat scanning. A prototype that only proves rows can be
stored, receipts can be written, or `inbox` can print a smaller list is not
testing the product.

## Rollout Notes

Implementation can still land in stages. A practical first landing slice is:

1. Inbox items for tasks, direct user/agent messages, blockers, reports, and
   async operation/mailbox completions.
2. Delivered/seen/handled records scoped by item ids, event ids, and explicit
   thread ranges.
3. `inbox` renders the current obligation view and marks included items
   seen.
4. `inbox_open(item_id, { mode: "ack" | "peek" })` hydrates one item without
   touching unrelated items in the same thread.
5. `inbox_handle(item_id, disposition)` closes, routes, snoozes, bounces, or
   blocks the item.
6. `RECENT SIGNALS` is not a generic feed in v1. It is a maintained watch view
   with strict source types and a reason each signal changes an obligation.
7. Monitoring-mode projections can start once the shared item and receipt
   protocol exists.

Current prototype slice:

- worktree: `.worktrees/agent-inbox-modes`
- keeps MCP `inbox` as the pull surface and removes the public `my_task` alias
- separates notification status from read-time inbox view:
  - status is persisted as `metadata.inboxStatus` plus optional
    `metadata.inboxStatusTag`
  - view is chosen per `inbox(view: ...)` call and is not the wake policy
- supports `default`, `current-task`, `monitoring`, `review`, and `all`
  formatting over the existing task/unread backend path
- adds exact-phrase sender priority:
  - `this is important` wakes `busy`
  - `this is urgent` wakes `dnd`
- stamps explicit per-recipient delivery metadata on chat events:
  `priority`, `inbox_delivery`, `inbox_status`, optional
  `inbox_status_tag`, and optional `notify_by`
- returns sender receipts that say whether the message notified, batched, or
  queued for the recipient
- changes wake/startup copy to prefer `inbox()`
- adds `set_delivery_channel(agent?, channel)` with `channel | tmux` as the
  consolidated delivery preference. Senders still use normal `chat()`; when a
  notified wake targets an agent whose preference is `tmux`, the server uses the
  internal daemon tmux nudge path so the agent is told to check `inbox()`.
  Agents may set their own channel freely. Setting another agent's channel
  requires being that agent's manager/delegator via an active task.
- removes the public `nudge_agent` tool; persistent `tmux` delivery replaces the
  one-off nudge API.

This prototype is not the full long-term architecture. It is a dogfoodable slice
of the pull surface plus status-shaped delivery. It still uses the existing
task/unread backend path rather than the long-term item/thread receipt model.

Release sequencing:

- inbox-modes is separate from the reliability RC.
- Do not merge inbox-modes before the reliability RC lands.
- After the RC lands, rebase `.worktrees/agent-inbox-modes` onto the new
  `mcp-server/fleet-tools.mjs`, `server/unified-server.mjs`, and
  `bin/lib/spawn/harness/claude.mjs` shapes before live dogfooding.
- Agents should call `inbox()` directly; `my_task` is not kept as a public MCP
  alias in this slice.

Rebase and dogfood checklist:

1. Rebase `.worktrees/agent-inbox-modes` after the reliability RC reaches main.
2. Resolve conflicts by preserving the RC's reliability fixes first, then
   re-applying `inbox` as an additive surface.
3. Verify the MCP registry exposes `inbox`, `set_inbox_status`, and
   `set_delivery_channel`, and does not expose `my_task`.
4. Verify `inbox()` with no args routes to the default view.
5. Verify `inbox()` renders bounded `NOW`, `BATCHED`, and `BACKGROUND`
   sections from explicit delivery metadata.
6. Verify `inbox(view: "current-task")`, `inbox(view: "monitoring")`,
   `inbox(view: "review")`, and `inbox(view: "all")` render distinct views over
   the same task/unread data.
7. Verify `set_inbox_status(status, tag?)` persists `metadata.inboxStatus` and
   optional `metadata.inboxStatusTag`.
8. Verify `chat()` receipts preserve the status/priority result, including
   idempotent retry with the same `_tempId`.
9. Verify a direct chat wake says to call `inbox()` and does not consume unread
   before `inbox()` is called.
10. Verify a task/delegate wake says to call `inbox()` and the task remains
   visible in `inbox()`.
11. Verify `nudge_agent` is not exposed as a public MCP tool.
12. Verify `set_delivery_channel(agent?, channel)` persists
    `metadata.deliveryChannel`, allows self-setting, allows a manager/delegator
    to set a delegatee's channel, rejects non-managers with the "delegate them a
    task first" recovery path, rejects `tmux` for agents without a tmux route,
    and causes future notified chat wakes to send a tmux ping to check `inbox()`.
13. Dogfood with at least one worker-like agent in `busy`, one unavailable
    agent in `dnd`, and one reviewer/release-like agent using
    `inbox(view: "review")`.
14. Send release-train the post-rebase diff, exact verification output, and
    dogfood notes before requesting a merge slot.

## Reviewer Feedback Incorporated

Mailbox/threading reviewers agreed the model fits if mailbox entries become
first-class `operation` inbox items and if item ids remain obligation ids
instead of fuzzy thread references. They also flagged three v1 constraints:

- `RECENT SIGNALS` must be a maintained watch view, not another chat firehose.
- Lifecycle events should create inbox items only when attached to owned work,
  a handoff, or an explicit watch.
- Attention modes affect presentation and delivered cursors only; they must not
  change routing, ownership, or item membership.

## Open Questions For Reviewers

1. Would a monitoring-mode agent want `NOW`, `OWNED WORK`, `WATCHLIST`, and
   constrained `RECENT SIGNALS`, or is that still too much?
2. What actions should be first-class for manager rows: interrupt, ask-status,
   delegate, bounce, snooze, watch, mark-handled?
3. Should `inbox` always advance seen receipts, or should it support a
   `peek` mode?
4. What should count as handled for a Skip message: reply sent, reply seen by
   Skip, or explicit mark-handled?
5. Which modes are missing beyond `focus`, `inbox`, `monitoring`, `incident`,
   `available`, and `review`?
