# Bot launch: mint with an exact-name argument, and wake on failure

Skip, 2026-08-18 14:21:43 EDT, verbatim:

> what it's supposed to do is call mint with a special argument that says instead of,
> like, rotating, fail if I don't get the name I'm asking for. AND IF YOU FAIL, WAKE

That is the whole specification. Three parts, in his order:

1. **The bot launcher calls mint with a special argument.**
2. **That argument means: do not rotate. Fail if the requested name is not the name given.**
3. **On that failure, wake** the being already holding the name.

Skip, 14:23 EDT, on the mechanism:

> It just uses the daemon ledger. Like, it's not complicated. **A bot is just an agent.**

So there is no bot-specific identity concept to build. The daemon ledger already records
the mint; that record is what says the being exists and is what `wake` resolves against —
which is exactly what `tlda agent wake chief-aug18` reported missing tonight
(*"no local mint recorded"*) for a process launched outside the mint path.

**Do not add a parallel notion of bot identity.** Bot launch is an agent mint with the
exact-name argument, and the wake on failure is the ordinary agent wake.

## The design he settled on, 14:27 EDT — keyed on the model, not the name

> one option is ... if we have no bot of this **model** in the ledger [we mint].
> Otherwise, we wake them.

Then, confirming it is name-independent:

> That's name-independent, right? It's model-specific.

**So the rule is: one bot of a model, for its whole life.**

- No bot of this model in the ledger → **mint** it.
- One already in the ledger, **under any name** → **wake** that one.

**Why this beats keying on the name**, which is where he took me first and then past:
renaming a bot does not change what model it is, so a rename cannot manufacture a
vacancy for a pushy launcher to fill. The duplicate is impossible by construction rather
than by a guard that has to fire.

**And the rename still stops the bot, using the guard that already exists.** You wake it,
it comes up, sees it is not under its canonical name, and stays inert — Skip, 2026-08-08:
*"a bot only runs under its canonical name … that way, we can't have two bots that do the
same thing doing the same thing."* Nothing new stops anything; the existing stop keeps
working.

**The path he rejected on the way**, so nobody rebuilds it: a canonical-name check in the
manager, or a stopped-flag beside the name. Both add a second fact that can drift from
the ledger.

## The trap is already in the code, at `agent-launch/harness/bot.mjs:24`

```js
export function resolveModel(model = 'bot') { return model || 'bot' }
export function resolveModelSelection(model = 'bot') { return { model: model || 'bot', provider: 'bot' } }
```

**Every bot's model resolves to the string `bot`.** That is `kind` wearing the name
`model` — precisely the confusion Skip corrected at 14:28 (*"A bot's kind is `bot`. A
bot's model is like, `todd`"*).

**So implementing "one bot of this model in the ledger" against `resolveModel` as it
stands would permit exactly one bot on the machine**, and the second declared bot would
find its model already present and be woken as the first. The model has to come from the
bot's declaration — `todd`, `dev`, `grammar`, `chat-lint` — not from this default.

**Check what the ledger actually stores for a bot's model before writing the query.** If
it stores `bot`, the uniqueness key does not exist yet and adding it is part of this
work.

## Minting is not broken — the break-glass path is

Established 2026-08-18 18:30Z, by running both:

- `tlda agent mint chief-night --model opus` → **joined, route published**, wakeable.
- `env -u FLEET_ID tlda doctor yolo --name … ` → process runs, **no mint record, no
  route**. `tlda agent wake` answers *"no local mint recorded"*.

**Every unwakeable row tonight came from the break-glass path**, including `chief-aug18`.
Do not reach for `doctor yolo` because minting "looks broken"; use the CLI and read the
error if it fails.

## What is there now, and why it is wrong

`agent-launch/harness/bot.mjs` hands the bot **two** names — `FLEET_NAME` (what the mint
gave) and `TLDA_BOT_REQUESTED_NAME` (what it asked for) — and the bot compares them
itself. When they differ it goes inert and logs
`inert: requested "todd", assigned "quiet-todd"`.

So the current design **rotates, launches anyway, and makes the bot discover at runtime
that it is not itself.** The name rotation is correct for two *different* beings wanting
one name; it is wrong for a being that already is that name.

Consequence, measured today: `dev` runs as `quiet-dev` and is inert. Its `node_modules`
eviction against the 50 GB budget, preview reaping and the `pw` pool all arm in `onOpen`
behind a correct gate, so **an inert `dev` sweeps nothing** — while the box carries ~38 GB
of worktrees across 536 and the disk reached 120 MB free.

## Not the design

Two things I proposed and he rejected, recorded so nobody rebuilds them:

- **Not the idfile.** *"it's not idfile"* — identity is not read from a file on disk.
- **Not "a mint of an existing being is silently a wake."** He said **NO** to that. The
  mint **fails**, explicitly, when it cannot have the name it asked for. The wake is the
  response to that failure, not a substitution for it.

The distinction matters: a caller that asked for a name and did not get it must be told,
and then the wake happens. Collapsing the two hides the failure.

## Where it goes

- Rotation lives around `server/lib/fleet-store.mjs` — `nameTakenByOther` (3502),
  `_nameTakenByOther` (1628), and the collision rotation at 966–998.
- The bot launch path is `agent-launch/harness/bot.mjs`; `cli/tlda.mjs` builds the args
  in-process, so **a long-lived bot manager holds old code until restarted** and the
  failure if you stop at the file is silent — bots start fine, unconfigured.
