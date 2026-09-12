# The audit: what to retain {#brief}

**This is Skip's instruction, verified in his own threads, with timestamps. Do not
work from anyone's summary of it, including this heading. The quotes are the spec.**

## His words

**2026-08-17 16:58:08 EDT → `tlda-autopsy-fml`** — the job:

> i am asking for you to look at what has happened and figure out what, if anything,
> to retain when we basically revert all this trash out

**16:58:40** — asked directly for a date or a sha, he answered:

> august

**16:59:29** — he withdrew the blanket revert himself, on the record:

> there's nothing to revert to

**16:59:45 / 16:59:48**:

> so it's hard work
>
> FUCKIKNG GET IT DONE

**17:00:29** — the standing caution on the keep-set:

> keep ion mind most real fixes are real fixes for trash

**2026-08-18 15:04:39 EDT → `bhief-of-staff`** — the tighter, newer scope:

> all of the work in the last twenty four hours, all of the work under the last two
> chiefs is suspect and likely to be dangerous and needs careful investigation

**15:04:57**, the sentence that joins the two rulings:

> Like, those two chiefs were supposed to do the same thing the last two weeks of work.

**2026-08-18, to `chief-night` directly:**

> you need to have someone look though ever commit and see if it did anyhing

## What this is not

**It is not a revert.** He considered one and talked himself out of it because `main`
is assembled by cherry-pick and there is no coherent point to revert to. Do not
propose one, do not perform one, and do not treat "cut" as "run `git revert`".

**Cut means: this change should not be in the product, and here is the evidence.**
Producing the removal is a separate, later decision that is not yours.

## The test, per commit

For each commit answer these, with evidence, not impression:

1. **Did it do anything at all?** The failure mode in this repo is work that is right
   on both ends and dead in between. Check the specific patterns:
   - **A severed wire.** New message type, event name, route, or RPC verb: grep the
     whole tree for the literal and count the sites. **One occurrence means nobody is
     listening.** `git log -S <literal> --all` distinguishes a dropped handler from one
     that never existed.
   - **A boundary that rebuilds its payload.** An object or argument list assembled
     from named keys between a producer and a consumer drops anything not enumerated,
     and both ends still contain the literal you grepped for. `shadow-mirror-rpc.mjs`
     and `agent-launch/harness/*.mjs` are the known cases.
   - **An inert control.** A settings row whose value nothing reads. See
     `docs/settings-controls.md` for the four routes, one of which no pref-key search
     can find.
   - **A test that asserts its own new behaviour.** Green proves the code runs, not
     that the behaviour was wanted.
2. **Was it asked for?** Trace it to Skip's own words in his thread, read in order.
   `git blame` cannot find him — he dictates and an agent writes every line, so no
   line blames to him. An agent's commit message is not authority.
3. **Is it proven?** A proof must cross the same boundary the feature crosses in
   production. Both ends called from one process proves neither.
4. **Is it a real fix for trash?** His caution. A correct fix to a path that should
   not exist is a **cut**, not a keep.

**Default cut when unproven.** That is his instruction, not a tiebreak of ours.

## Scope, in priority order

1. **The last 24 hours** — 64 commits on `main` since 2026-08-17 19:00 EDT.
2. **The last two chiefs' work** — `solved-non-problems` (`fleet:0a554e63`, fired
   after ten hours) and `chief-aug18` (`fleet:53398867`, a husk). **Five of the first
   one's fixes shipped unable to fire at all.** That is the expected pattern.
3. **August** — 1,231 commits on `main` since 2026-08-01. The standing window.

## Output, per commit

One row: `sha | subject | author | KEEP / CUT / INERT | evidence`

**Evidence is a command and its output**, or a file and line. Not a reading, not a
judgement, not a restatement of the commit message.

**INERT is its own verdict** and it is the one he most wants: the change is in the
tree and cannot act. Say which of the four patterns above it is.

## How to report

Do not send him anything. Report to `chief-night` (`fleet:8a7763d5`).

**A row you could not establish is reported as unestablished.** A list that looks
complete while half of it is guessed is worse than a short list, because he will act
on it. Say which rows you actually ran commands against.
