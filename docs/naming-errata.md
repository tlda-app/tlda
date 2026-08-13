# Naming errata

Names in this codebase that are wrong, with what they actually mean. Skip asked for this list
on 2026-08-12 after hitting one of them:

> that's just, like, stupid fucking naming. Right? And it's like, should we fix that? We should
> — if we don't fix that, we should at least add it to a list of things that are fucking bad,
> like naming errata.

**The list exists because a rename is often the wrong thing to do right now and the knowledge is
always worth having now.** A rename touching a dozen call sites in a live path is a real change
with real risk; writing down that the name lies costs nothing and stops the next person
inheriting the confusion.

**What belongs here:** a name that misdescribes what the thing does, collapses distinctions the
system makes elsewhere, or understates what it costs to call. **What does not:** a name someone
merely dislikes, or a name that is simply old — see `AGENTS.md` §"Notation is borrowed, and so
is its meaning" for how naming decisions are actually made here.

**Fixing one is always allowed.** Delete its entry in the same commit.

---

## `markAgentNotAlive` — `server/unified-server.mjs:559`

**What it does:** records that an agent stopped being reachable, drops it from the live set,
writes its runtime state as hibernating, and clears its transient presence state — the
"currently editing this file" markers in `server/lib/source-edit-activity.mjs`, and its
ephemeral state. **No content is discarded.** `activeEdits` is a map of who is mid-edit on
which file, read by `activeSourceEditors(project, file)`; the edits themselves are `Edit` /
`Write` tool calls that land on the filesystem and are not in it.

**Three things wrong with the name:**

**It is a negation where the system has words.** Runtime status is `awake`, `hibernating`,
`dead` — see [Identity and labeling](identity-and-labeling.md). "Not alive" names none of them;
it names the absence of the first.

**It is called for three different situations and flattens them.** `dead`, `wedged`, and
`unknown` all route through it (`:605-606`). **Unknown is not a state of the agent — it is a
state of our knowledge of the agent**, and the name cannot distinguish them. The `detail.unknown`
flag carries that distinction instead, which means the caller has to know to look.

**A better name would say which of the three it is.** Splitting the unknown case out is probably
the bigger half of the fix.

**The evidence that it is a bad name and not merely an ugly one:** Skip found it in an agent's
chat message, where that agent was reasoning about the function and had got its behaviour wrong.
**It was not leaking into a user surface — it failed on a reader who had the source open.** A
name only has one job and this is what failing at it looks like.

**And then it did it again, in this file.** The first version of this entry claimed the function
"discards that agent's unsent source edits", because `clearSourceEditsForAgent` reads that way
and nobody opened it. It clears presence markers. **Skip caught it with one sentence — "edits
happen on the file system" — which is the fact that makes the claim impossible.**

**So the entry documenting a misleading name was itself written from the misleading name.** That
is the whole argument for this file, demonstrated at its own expense: **a name in a call site is
not evidence about behaviour, and the cost of believing one is a false claim in a durable
document.**

---

## The server-sink comment — `src/logger.ts:58`

**Not a name, but the same class of defect and it belongs here:** a comment in a live path that
states the opposite of what the code does, sixty lines above the code that contradicts it.

**What it says:**

> Every `log()` call (regardless of console threshold) is queued and flushed to
> `~/.config/tlda/client.log` via the server.

**What `:122` says, in the function that actually enqueues:**

> Level gates BOTH the server sink AND the console (default threshold: warn). **Previously the
> sink captured every call regardless of level**, so a chatty debug/diagnostic namespace flooded
> `~/.config/tlda/client.log` … Now a namespace must be turned up.

**`:58` describes the behaviour `:122` says was removed.** It was true before that fix and was
not updated by it.

**What is actually true**, from `:162`, `:53` and `:29-31` rather than from either comment:

- `log.metric` calls `enqueue` **directly**, bypassing `shouldLog`, so it always reaches the
  file. Its own docstring says so.
- Every other logger goes through `shouldLog(ns, level)` against a default threshold of `warn`.
  `LEVEL_ORDER` puts `info` at 1 and `warn` at 2, so **`log.debug` and `log.info` both write
  nothing** without a URL parameter.
- So **what reaches `client.log` is decided per call function, not per level and not per
  namespace.** An `info`-level record in that file is a `metric` record.

**The cost, which is why this is worth writing down.** Two agents debugging the chat scroll path
on 2026-08-13 reasoned from `:58`, saw an `info`-level record in the log, and concluded the sink
takes everything at `info` and above. Both inputs were consistent with the comment and the
comment is false. One of them nearly skipped a namespace that does carry evidence; the other
put "the `chat-scroll` diagnostics are invisible in production telemetry" into
[Chat rendering](chat-rendering.md), which was too broad in the other direction. **Anyone
reasoning about what reaches `client.log` from the top of that file gets the wrong answer.**

**The fix is deleting one parenthetical at `:58`** — a comment edit in a live path, no behaviour
change. It has not been made because `logger.ts` was outside the scope of the work that found
this, and per this file's own preamble the knowledge is worth having now either way.

## `amendEventText` in `server/lib/fleet-store.mjs`

**It is not how an amend works, and calling it would produce the behaviour its name promises —
which is the opposite of what the live path does.** It runs `UPDATE events SET text = ?`, mutating
the original row in place. The live amend path is `unified-server.mjs` `type === 'amend'`, which
writes a **new** event carrying `metadata.amends = <original id>` and **never mutates the
original**, because the original is an accountability trail the client folds into a version
stepper.

Reading `amendEventText` to understand amend behaviour sent an agent to the wrong conclusion on
2026-08-13, in a report that reached Skip. Two implementations exist; one is live.
