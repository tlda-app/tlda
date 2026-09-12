# Chief handoff — 2026-08-22 13:5x EDT

Written against: testing serving `027d5d940`; local `main` at `c866ab9f3` + later
commits, **14 ahead of deployed**, all verified or documentation. Nothing deployed
without Skip's explicit word.

## The target, settled by Skip and not to be re-derived

**Agents are not being woken by activity in the app. Never his screen.**

His words, 2026-08-22 13:4x: *"I don't need notifications ever… The problem is
agents are not receiving notifications. To my or any behavior that takes place in
the app."*

When he writes *"including MY chat messages"* he means **messages he sends do not
wake the recipient agent.** Do not read it as his own notifications. That
misreading cost hours today.

## Hypotheses that are DEAD — do not spend time re-deriving these

- **The amend path is not the defect.** Skip ruled it: that path is quiet by
  design, and agents announce what they do, so nothing is silently changed under
  him. Do not raise it with him again — he has banned the word.
- **The stale-tap-cache path is real, proven on ordinary chat, and rare.** Its
  missing-notification direction needs a `dead → alive` transition. The fleet
  shows **0 dead of 2693** and two days of record contain no reanimations. **It is
  not his breakage.** Fixed anyway; do not present it as the answer.
- **His own notification surface is not the problem and never was.**
  `requestWake` refuses humans on sight (`unified-server.mjs:5914`,
  `reason: 'human-agent'`) — by design, always has. Every subscription, cache and
  wake in the server notifies *agents*. His in-app notification is entirely the
  browser client, untouched by any of this work.
- **His subscriptions are healthy** — `to:me` and `to:my_labels`, both
  `immediate`. Nothing wrong with his rows.

## What is established about the live defect

**Nine ways an ordinary chat produces no wake** — pending shell; no channel *and*
no daemon route (`accepted`, no wake); stale tap cache; unparseable subscription
query (silently unnotifiable forever, warns only at hydration); label-addressed
without `to:my_labels`; unparseable policy string (falls through **and misreports
the reason as "no matching subscription" when one matched**); `hold`/`batch`;
native subagent; and wake reaching the daemon with no daemon connected.

**Two ways a chat produces a wake.** `requestWake` is the only producer:
1. the MCP channel acks → `agent-channel-acked`
2. everything else → the daemon, which types text into a pane

**And for codex and goose the first does not exist.** `deliverChannelNotice`
switches on harness: claude → channel, codex → pane, goose → pane. For two of
three harnesses pane typing is not a fallback, it is the only path. Consistent
with `WAKE_MCP_ACK_DEADLINE_MS` being `2000` for claude and **`0`** for everything
else (`unified-server.mjs:977`).

**The ack means "the MCP client handed it off", not "the agent received it"** —
pane typing returns `delivered = true` identically to the channel, so the server
records `agent-channel-acked` for a codex agent when text was typed at a terminal.

**Two design lines the code contradicts**, from `docs/fleet-agents.md`:

> Chat is also the wake mechanism for a hibernating agent.

> Missing daemon routes fail explicitly; they never authorize local fallback.

**A hibernating agent has no pane.** Skip, correcting me: you wake one by starting
its process, which is what creates the pane. So pane typing can only ever reach an
agent that is already running — it has no legitimate case, and the case it does
serve is routing around a broken channel for a live agent.

**Skip's design statement:** a missing ack means the daemon should find out why
the MCP is unresponsive — **not deliver the message another way.** Persistent
sideband delivery to the daemon is not the design.

## A tenth mechanism, environmental, not in the nine

**The MCP client itself wedges under box load, and that is a delivery failure the
nine do not cover.** Observed twice within minutes at **load 43** on 2026-08-22
14:0x: the tools vanished, the MCP *process* stayed up (13h55m old), and the
binding reconnected on its own without a restart.

There is a memory on this — `never-self-restart-mcp-from-your-own-turn.md`, whose
**description says SUPERSEDED and whose filename says the opposite.** Read the
body, not the name. Its measured account: a 2 s abort in the native child binding
with the daemon starved at load 38–67; reads work briefly after connect, the
**first write** wedges the client, and reads die behind it — **while inbound
notifications keep arriving, so the roster still says `awake` and last-seen looks
fresh.**

So an agent can be listed healthy, be genuinely unreachable, and nothing reports
it. **That is the same shape as the nine — delivery failing while the surface
says fine — but it is environmental and no subscription fix touches it.** If
notifications still look intermittent after the branch deploys, check box load
before concluding the fix failed.

`tlda-dev restart-mcp <name>` goes through the daemon and is safe to run on
yourself; session and conversation survive.

## Standing

- **Sync: stood down by Skip.** He called the direction wrong. Worktrees and
  branches left in place, nothing committed, no wind-down reports.
- **Search: fixed and live** — 24.8 s → 1.3 ms, hand-built index on the running
  machine; the `COPY` that makes it survive a deploy is on `main`, undeployed.
- **`main` is 14 ahead of deployed** and `npm test` is red on it — ~60 files,
  sampled 8, 7 identical at the deployed sha. **Both that count and the control
  were measured while an orphan server held a port**, so neither is established.
- **The paper** is ready to push: `~/worktrees/synth-additive`, 4 files, 330
  added, 0 removed.

## Two rules this seat broke today, worth inheriting

**A zero from an instrument that cannot see the thing is not a zero.** Four times:
`roster(cwd:)` empty for every agent; a search returning `0 session` rows from the
broken path; a binding filter testing truthiness against explicit nulls; a `ps`
grep counting its own pipeline. And twice in the other direction — inventing a
`thread` defect from a window that was simply too narrow.

**Do not report a retreat as an achievement.** The territory fix stopped the app
writing his checkout and put nothing in its place; I told him the app "no longer
touches your git" as though that were the deliverable. His answer: *"i fucked it
up so i wont so now that youre asking for it to work, i wont donit at all."*
