# Bot Supervision Findings, 2026-08-10

This records the bot supervision state found during the launchd waiter rollout.

## Confirmed live-process count

At 2026-08-10 03:48 EDT, direct checks of each bot's own identity/pid files and
the process table found 6 of 11 configured bot jobs with a live bot process.
`tlda bot status`, launchd, and the roster were not sufficient evidence because
they could report a stranded launchd waiter as healthy.

The transferable rule is that bot liveness must be read from the bot process,
not from the supervisor. The sharpest example in this survey was
`chat-lint.stable`: `tlda bot status` reported `running + supervised` while the
job had no identity file or pidfile and launchd was only supervising a stranded
waiter.

Dead at that check:

- `chat-lint.stable`
- `grammar.stable`
- `nobody.stable`
- `teacher.stable`
- `todd.testing`

## Dead stable jobs

- `chat-lint.stable`: missing `~/.config/tlda/chat-lint.stable.fleet-id` and
  missing pidfile. The launch command cannot start because its first operation
  reads the identity file.
- `nobody.stable`: missing `~/.config/tlda/nobody.stable.fleet-id` and missing
  pidfile. The launch command cannot start because its first operation reads the
  identity file.
- `grammar.stable`: has identity `fleet:grammar` and pidfile `45874`, but its
  plist is the old direct tmux form and points at missing
  `/Users/skip/work/tlda/bin/bots/grammar-bot.mjs`.
- `teacher.stable`: has identity `fleet:d0722d34` and pidfile `801`, but that
  process is not live. Its plist uses the current `tlda agent wake` form.

These are repair items, not rollout steps. The four stable jobs do not share one
cause.

## They mostly do share one cause: the fallback fleet id has no environment in it

Re-examined at 10:10 UTC against both servers' agent rows, which the account
above did not consult. Three of the four descriptions are incomplete and one is
wrong.

A bot with no identity file and no `FLEET_ID` in its environment invents one:

```js
const BOT_KEY = (process.env.TLDA_BOT_REQUESTED_NAME || process.env.TLDA_BOT_NAME || 'lint').toLowerCase()
const id = `fleet:${BOT_KEY}`      // tlda-bots/lint/lint-bot.mjs:71
```

`BOT_KEY` is the bot's name alone. **The environment is not in it**, although
every path beside it is environment-scoped — `chat-lint.stable.fleet-id`,
`chat-lint.testing.fleet-id`. So the same bot in two environments derives the
same id, and the daemon's mint ledger is machine-wide and keyed by fleet id.
Whichever environment minted first owns the mapping.

The agent rows show it directly:

| name | on `testing` | on `stable` |
| --- | --- | --- |
| `grammar` | `fleet:grammar` | `fleet:grammar` — same id, two servers |
| `chat-lint` | `fleet:chat-lint` | no row |
| `todd` | `fleet:f1e9c0be` | `fleet:c3d5e4ff` — distinct, and it works |
| `nobody` | `fleet:848885b2` | no row |
| `teacher` | `fleet:91e5a81b` | `fleet:bd3541fd` |

The bots that work got random ids from a supplied `FLEET_ID`; the ones that
collide fell through to the deterministic branch.

**So `grammar.stable.fleet-id` is not "the testing bot's identity".** Stable has
its own `grammar` row and its id genuinely is `fleet:grammar`. The file is
correct for the server and unusable on the machine: waking it resolves through
the local ledger to `bot:testing:grammar`, whose tmux session is live, and the
wake is refused —

```text
Error: wake did not produce a live runtime for bot:testing:grammar:
tmux session fleet-bot-grammar_testing already has a live harness runtime
```

**`teacher.stable` is also mis-described.** Its identity `fleet:d0722d34` is, on
the stable server, the agent named **`seacher`** — the rotated name from a
previous collision. Stable's actual `teacher` row is `fleet:bd3541fd`. The name
`teacher` is held by that row, which is hibernating and therefore not dead, so a
fresh mint rotates again and the bot goes inert exactly as `AGENTS.md` describes.
The rotation is the design working; the wrong id in the file is not.

**Writing identity files by hand does not fix this.** The bot rewrites the file
from `fleet:${BOT_KEY}` whenever it bootstraps without one, so a hand-seeded id
survives only until the next cold start — and for `chat-lint` it would revert to
`fleet:chat-lint`, recreating grammar's collision exactly.

### The fix already exists in `todd`; it was never backported

`todd/todd.mjs:93` is the same function with the last line changed:

```js
const id = `fleet:${randomUUID().slice(0, 8)}`   // todd/todd.mjs:108
```

Random, not name-derived, so two environments cannot collide. It also validates
an existing file and throws on a malformed id instead of accepting it.

**That is why `todd.stable` is the one stable bot alive.** Not configuration —
its identity derivation was fixed and the others' were not. Verified using the
name-derived form: `tlda-bots/lint/lint-bot.mjs:71` (this is `chat-lint`) and
`tlda-bots/dev/dev-bot.mjs`. `grammar`, `nobody`, and `teacher` do not derive an
id themselves and take whichever one they are handed.

So the change is a backport of a pattern already running in production, not a new
design.

### The migration question, which is why nobody should run it yet

**The backport on its own does not fix three bots. It changes how they fail.**
Give `grammar` a fresh random id and the old `fleet:grammar` row still holds the
name `grammar` on stable — a hibernating row occupies its name — so the new mint
rotates to something else and goes inert, exactly as `teacher.stable` does today.
Three name-collision failures become three name-rotation failures: the same dead
bots, for a more confusing reason. **The old rows have to be disposed of in the
same operation, which is why the sequence matters more than the diff.**

Changing the derivation changes the identity a bot gets **on its next start**,
and the six live testing bots are running under the current ids right now. Before
anyone applies this, answer:

- What happens to the existing `fleet:chat-lint` and `fleet:grammar` rows on each
  server once no process claims them — orphaned, dismissed, or left hibernating
  to hold their names? Note that a hibernating row still occupies its name, which
  is what makes `teacher.stable` inert today.
- What happens the next time a bot Skip is using restarts — does it come back as
  the same agent, or arrive as a new one and lose its thread?
- Does anything else key off the deterministic ids? `fleet:chat-lint` is guessable
  by construction and may be referenced somewhere as a literal.

None of that is answerable from this repository; the bots live in `tlda-bots`.

## `tlda config apply` cannot be run by an agent, ever

`assertOwnerCapableLaunchdManager` (`cli/lib/config-apply-transition.mjs:6`)
requires `launchctl managername` to return **`Aqua`**. Every agent session on
this machine reports **`Background`**, so the command prints its whole plan and
then stops with:

```text
configuration is not applied
```

This is not flakiness and retrying does not help. `tlda config apply` runs from
Skip's own terminal or not at all. Scope it when you hand it over — bare
`config apply` is all-or-nothing across every managed job, so a stable-only
repair is `tlda config apply --only stable`.

## Launchd apply note

During this rollout, `tlda config apply` sometimes failed with:

```text
Bootstrap failed: 5: Input/output error
```

The same command later succeeded for `nobody.testing` when run again from Skip's
terminal, and five more jobs applied cleanly from that terminal without hitting
the error. The source of the flakiness is unexplained; the working operational
rule is to retry once rather than treating the first failure as evidence that
the generated plist is bad.

## Wake false success on shell-only sessions

`todd.testing` exposed a second false-success path after the launchd waiter fix
landed. Its launchd job moved to the new pane-pid waiter, but todd still did not
write a fresh heartbeat. The blocking state was:

- `fleet-bot-todd_testing` existed.
- Its pane process was a bare `zsh`, not a bot runtime.
- `~/.config/tlda/todd.testing.pid` pointed at a dead process.
- `~/.config/tlda/todd.testing.heartbeat` was still stale.

The wake path reported success because `spawnTmux()` treats an existing
shell-only session as a non-destructive no-op:

- `agent-launch/tmux.mjs:132`: `spawnTmux()` tries `tmux respawn-pane`; when
  that fails and the tmux session exists, it returns `false`.
- `agent-launch/index.mjs:910`: `spawnRespawn()` treats that as success:
  `if (!launched) return { ok: true, fleetId, tmuxSession, harness: requestedKind, model, alreadyAlive: true }`

So `tlda agent wake fleet:f1e9c0be` printed `Woke ...` even though no todd bot
process started.

The control was `nobody.testing`: during the pilot, its tmux session was killed
before wake. With no shell-only session blocking launch, the same wake command
shape started the bot and produced a fresh heartbeat.

Proposed fix shape, not applied here: a shell-only existing session should be a
wake failure, not `alreadyAlive: true`. `alreadyAlive` should require a confirmed
runtime process.

## Wake failure after the liveness fix

Commit `902cdd270` made that proposed shape current behavior. A wake that finds
an existing tmux session with no live runtime now fails with an explicit
"exists but has no live runtime; wake declined to replace it" error instead of
returning `alreadyAlive: true`.

For launchd-supervised bots, the consequence is a visible retry loop rather than
a silent death: wake exits, launchd restarts the job, and the next launchd pass
tries wake again. That is the intended non-destructive trade for this patch.

The alternative is for wake to tear down the dead tmux session and replace it,
which would self-heal instead of looping. That is a design change, not a repair:
wake is deliberately non-destructive today.
