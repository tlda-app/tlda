# Bot name-rotation deadlock, and the `debt` mint storm

Measured on `mini` at **2026-08-23T02:48Z** (22:48 EDT) by `mini-load`, while bringing
the box's load down. This is a resumption point for whoever owns the fix, not a log:
the state below is expensive to re-derive because it needs the running panes, and a
pane's `inert:` line is the only place the fault is visible.

## The mechanism

`bot-manager` decides whether to start a bot by asking whether there is a **live
process**, then mints under the bot's canonical name. A hibernating agent is still a
*living* agent, so it holds its name against the partial unique index. The mint
therefore collides, the server hands back an alternate name, and the bot comes up and
declares itself **inert** — which is the design working exactly as `AGENTS.md`
§"A renamed mint and an inert bot are both the design" says it should.

What is wrong is upstream of that: the check is keyed on the **name**. `AGENTS.md`
§"One bot of a model, for its whole life" says it must key on the **model** —
*"if we have no bot of this model in the ledger [we mint]. Otherwise, we wake them"* —
precisely so that a name being held cannot manufacture a vacancy.

The fallback path does try to wake, and it fails:

    tlda agent wake bot:testing:debt
    Error: no local mint recorded for bot:testing:debt

So neither branch can converge. Mint cannot have the name; wake cannot find the mint.

## What was measured, per bot

Read from each bot's own pane output, not from a status field.

| pane | canonical name | assigned name | state |
|---|---|---|---|
| `fleet-teacher` | `teacher` | `quiet-teacher` | inert |
| `fleet-teacher-84` | `teacher` | `teacher-84` | inert |
| `fleet-grammar-92` | `grammar` | `grammar-92` | inert |
| `fleet-nobody-85` | `nobody` | `nobody-85` | inert |
| `fleet-chat-lint-95` | `chat-lint` | `chat-lint-95` | inert |
| `fleet-dev` | `dev` | `dev` | **healthy**, sweeping normally |
| `fleet-todd` | `todd` | `todd` | **not inert** — see below |

The `-84`/`-92`/`-95`/`-85` panes connect to **stable**; `fleet-teacher` connects to
**testing**.

## `todd` is a different fault, do not fold it in

`todd` is running under its **canonical** name and is **not** inert. Its pane shows
every request to Fly failing:

    [todd] self-check roster refresh failed: GET /api/fleet-table?limit=500 timed out after 15000ms
    [todd] hibernation sweep failed: ... timed out after 15000ms

So the missing heartbeat is the **server timing out**, not the rotation deadlock. An
MCP `roster()` call from this session timed out the same way at the same time, which is
independent corroboration that the fault is on the server rather than on this box.

I reported these as the same cause in my first message to `chief-advocate-2` and that
was wrong; this file is the corrected version.

## The `debt` storm this produced

Same deadlock, but `debt` had no process at all, so `bot-manager` retried it forever —
roughly every 10 seconds, a fresh `tlda` node process per attempt, which is where the
box's zombie processes were coming from:

    bot-manager: debt:testing: no live process — starting
    bot-manager: debt:testing: mint did not get the name "debt" — waking bot:testing:debt
    bot-manager: debt:testing: wake exited 1

`/Users/skip/.config/tlda/bot-manager.log` holds **20,722** such lines. It was still
running when found, not historical.

Stopped by holding `debt` out of the `testing` list in
`/Users/skip/.config/tlda/bots.yaml`, with the reason written beside it in the file's
own idiom. The manager re-read its config and now reports `supervising 11 bot(s)` with
`debt` absent. **That is a tourniquet, not the fix** — restore the line once
`tlda agent wake bot:testing:debt` succeeds. The bot itself was never the problem.

## The `*.heartbeat` files are not heartbeats, and that is why they grow

Measured **2026-08-23T02:5xZ**, in `/Users/skip/.config/tlda/`. **180.0 MB across 14
files**, excluding `backups/` and excluding
`daemon-outbox.testing.sqlite.pre-heartbeat-wipe` — that last one is 338.8 MB and
matches a `*heartbeat*` glob, but it is a sqlite backup, not a heartbeat. Do not count
it.

| file | size | last written |
|---|---|---|
| `todd.heartbeat` | 50.5 MB | **2026-07-25** — orphan, untouched for a month |
| `debt.testing.heartbeat.retired-2026-08-23` | 32.6 MB | 2026-08-21, now retired |
| `todd.testing.heartbeat.retired-2026-08-20` | 21.7 MB | 2026-08-20, retired |
| `dev.testing.heartbeat` | 21.5 MB | live, seconds old |
| `grammar.testing.heartbeat` | 14.2 MB | live |
| `chat-lint.testing.heartbeat` | 12.2 MB | live |
| `todd.stable.heartbeat` | 11.6 MB | live |
| `grammar.heartbeat` | 6.9 MB | **2026-07-25** — orphan |
| `grammar.stable.heartbeat` | 6.1 MB | live |
| `chat-lint.stable.heartbeat` | 1.7 MB | live |
| `todd.testing.heartbeat` | 0.2 MB | live, 8 min old |

**The important part is the content, not the size.** The tail of
`dev.testing.heartbeat` is not a timestamp:

    ...(`fleet:9088cd80`) has incoherent mint/daemon join state after 173 minutes.
    - fleet seat exists, but there is no `permission_grants` row ...
    ","repeats":2,"nextNudgeAt":1787463998840}

That is the bot's **finding dedup and nudge-scheduling state**. So the obvious remedy —
*a heartbeat is a timestamp, overwrite it in place* — **would silently destroy the
dedup state and re-nudge everything**, which is the 3am surprise, arriving from the
other direction. Whoever fixes this has to separate the two concerns first: a liveness
timestamp that may be overwritten, and durable per-finding state that may not.

This is a `docs/naming-errata.md` candidate on its own: the name says heartbeat, the
file is a bot state journal.

**Two of the files are dead weight and are the largest.** `todd.heartbeat` (50.5 MB)
and `grammar.heartbeat` (6.9 MB) have not been written since 2026-07-25 — they predate
the environment-suffixed names and nothing writes them now.

**Not fixed, deliberately, and nothing was truncated.** A bot's liveness check may read
the tail of a live file, so emptying one underneath a running bot is unsafe. Recorded
only.

**One stale premise this retires:** `todd` *is* writing a heartbeat —
`todd.testing.heartbeat` was 8 minutes old when measured. The report that it had stopped
an hour earlier no longer holds; see the Fly-timeout section above for what is actually
wrong with `todd`.

## Ledger rows without processes

`tlda agent list` for testing shows **7 rows named `dev`** and **4 named `todd`**, all
`awake`, against exactly **one** live process each. Those rows cost no CPU and are not
worth chasing for load, but they are what a name-keyed check collides with.

## The testing todd stopped at 01:37 on 2026-08-23, four minutes after a deploy

Added by `chief-advocate-2`, 02:00, as a correlation rather than a diagnosis.

- `todd.testing.heartbeat` last written **01:37**
- the `quiet-todd` tmux session — the rotated name the testing todd was running
  inert under — is **gone**; it was present in the 19:46 roster
- the only live todd process is `TLDA_ENV='stable'` (`fleet-bot-todd_stable`),
  which is a different bot in a different environment and is unaffected
- a deploy landed at **01:33** (`a2adffdff`), and the deploy hook rolls
  `~/worktrees/daemon-testing` and **restarts the daemon**

**Not established: whether the daemon restart is what stopped it.** Three earlier
deploys the same night also restarted that daemon and the testing todd survived
them, so the obvious story does not fit without more. The alternative is that it
was already inert under a rotated name and something unrelated reaped the session.

**What would settle it**, for whoever picks this up: the bot manager's own log
around 01:33–01:37, and whether it attempted a relaunch and got a rotated name
again. `todd.testing.log` does not answer it — its tail is a repeating
`Wake attempt … / Woke fleet-todd (fleet:f1e9c0be)` pair, which is worth a look on
its own as a possible wake loop of the same family as the `debt` one above.

**Deliberately not acted on.** Poking bot supervision at 2am to chase a helper bot
is how the `debt` loop got three husks made while someone tried to fix it.

## The bot manager is dead and launchd does not know — 2026-08-23 06:10Z

This supersedes the todd correlation above: todd did not stop on its own.

```
last bot-manager.log line        2026-08-23T04:56:22Z   (73 minutes before this)
ps for a bot-manager process     none      (control: 4 fleet-daemon processes found)
launchctl list | grep            not listed
launchctl print gui/<uid>/com.tlda.bot-manager
                                 state = running,  runs = 3
```

**launchd believes the job is up. There is no process.** That is why the daemon
restart at 05:33Z did not bring it back — nothing was watching for it to be gone.

**Its last logged action was `dev:testing: no live process — starting` /
`already in the ledger — waking bot:testing:dev` at 04:56:22Z, which is the same
minute the wake-key remedy bug killed `dev` and one other agent.** So a causal
link is plausible and **is not established** — the manager may have died of that,
or alongside it. Do not repeat this as cause.

**Consequence:** nothing supervises any bot. The bots themselves are still up —
`todd:stable` (1d16h), `grammar` (3d), `dev-bot` — and note `dev-bot`'s process is
only ~31 minutes old, restarted at ~05:38Z with the manager already dead. **That
was the new `ensure-process` remedy doing the manager's job off a `no-channel`
symptom**, which is the spec working, and it is also why this went unnoticed.

**The remedy is `launchctl kickstart -k gui/<uid>/com.tlda.bot-manager`, and it was
deliberately NOT run**, at 02:10 local, on a box that took an hour to come down
from load 15. Restarting the supervisor is what re-mints bots, and a name-keyed
re-mint is the loop documented at the top of this file. Worth doing awake, with
`bots.yaml` checked first.
