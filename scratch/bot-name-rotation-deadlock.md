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

## Ledger rows without processes

`tlda agent list` for testing shows **7 rows named `dev`** and **4 named `todd`**, all
`awake`, against exactly **one** live process each. Those rows cost no CPU and are not
worth chasing for load, but they are what a name-keyed check collides with.
