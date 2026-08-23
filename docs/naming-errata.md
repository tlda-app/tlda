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

**And a third time, on 2026-08-19, in the direction that now matters most.** Skip's ruling that
night was *"DEATH IS A FUCKING FLAG IN THE DATABASE. A FLAG THAT IS ONLY SET EXPLICITLY."* An
audit reading `else if (liveness.state === 'dead' || liveness.state === 'wedged')
markAgentNotAlive(agentId, detail)` reported it as a second inferred-death path — a `wedged`
verdict invented from a 90-second timeout, marking an agent dead.

**It does not mark anything dead.** `markAgentNotAlive` never touches the `dead` column. It
writes runtime-status evidence and calls `recordRuntimeState` with **`detail.status ||
RUNTIME_STATUS.HIBERNATING`**, so the default outcome of the whole function is *hibernating* —
which is the state Skip says a non-running agent should be in.

**The relationship is the reverse of what the name suggests.** `recordRuntimeState` computes
`agent.dead ? RUNTIME_STATUS.DEAD : …` — it **reads** the column to decide what to record.
So the `dead` flag is an *input* to runtime status, never an output of it. Even the two
kill-session callers that pass `status: RUNTIME_STATUS.DEAD` explicitly do not thereby kill
anything: that status only survives because those paths call `markDead` separately, and if they
did not, the column would override the argument.

**So the name costs a specific thing, and it is worse than confusion:** it makes an auditor
looking for inferred death find a false positive, in a file where real ones existed. Two of the
three flattened cases in this entry are `dead` and `wedged`, and neither is a death.

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

## `FLY_API_TOKEN`

**It does not set the token `flyctl` uses.** `flyctl` answers from the ambient login and ignores
the variable, so a wrong value, a garbage value and the empty string all authenticate — verified
here on 2026-08-13:

```
FLY_API_TOKEN=fm2_garbage… fly auth whoami   → davidahirshberg@gmail.com
FLY_API_TOKEN=""           fly auth whoami   → davidahirshberg@gmail.com
fly auth whoami --access-token fm2_garbage…  → You must be authenticated to view this.
```

**So a check written as `FLY_API_TOKEN=$candidate fly auth whoami` proves nothing about the
candidate** — it reports whoever is logged in. The discriminating form is
`fly auth whoami --access-token <tok>`, which rejects garbage. An agent establishing whether a
leaked credential was still live nearly reported a false positive from the first form and caught
it by adding garbage controls.

## `~/.config/tlda/<bot>.<env>.log`

**It is not the bot's log. It is the launcher's.** The file holds the stdout and stderr of the
`tlda agent mint` / `tlda agent wake` CLI children the bot manager spawns — `runBotCliCommand`
opens it at `cli/tlda.mjs:2017` and hands it to those children as their `stdio`. **The bot
process's own output goes to its tmux pane and is written to no file at all.**

So the file named after a bot tells you what its *supervisor* tried, never what the *bot* did.
It is also append-only across process lifetimes with no pid marker, so a `tail` silently mixes
output from processes that died days apart.

**This cost most of a night on 2026-08-17 — three separate failures, each of which reported
healthy in every place anyone looked:**

- `chat-lint.testing.log` held 79 wake deferrals and no sign of the real fault. Its pane said
  `[lint-bot] login failed Agent login for "fleet:40af7509" requires daemon route information.`
  **chat-lint had been unable to log in since 2026-08-11 — six days** — while its 30s `tick`
  heartbeat kept writing, its tmux session stayed live, and its supervisor stayed satisfied.
- `todd.stable.log` ends `assigned_name=todd canonical=true`. The **running** process's pane says
  `assigned_name=quiet-todd canonical=false` and `inert:`. Those canonical lines belong to earlier
  processes; nothing in the file says so. todd:stable was reported as healthy on that basis.
- `todd.testing.log` gave no hint that every one of todd's HTTP calls was timing out at 15s. The
  pane did, immediately — and that turned out to be the best lead on a fleet-wide query-scale
  problem Skip was hitting as a 45s `fleet-search` timeout.

**The read that works:**

```sh
tmux capture-pane -p -S -40 -t <session>     # fleet-<bot>, or fleet-bot-<bot>_<env>
```

**Check the pane before concluding anything about a bot**, and treat the `.log` as evidence about
the launcher only. Every liveness signal available — live process, ticking heartbeat, live tmux
session, `ESTABLISHED` socket, satisfied supervisor — was green for all three of the above.

## `activity-health` — `daemon/delivery-policy.mjs`

**It is a heartbeat. It shares nothing with `activity-event` but a prefix.**

`activity-event` carries **activity** — Skip's definition: *"tool calls. status changes (idle
etc)."* Those are his activity cards, they are durable, and a lost one is data loss:
*"mostly ignorable but if its the wrong event not good."*

`activity-health` carries **liveness** — a periodic claim that an agent is still there. Skip:
*"a heartbeat is not activity."* The server assigns it to a single overwritten field
(`metadata.activityHealth`), so every one but the newest per agent is superseded before
anything reads it. It is `DELIVERY_LATEST_WINS`.

**The name cost two corrections in twenty minutes on 2026-08-18**, because *"don't drop
activity"* and *"drop the health beats"* sound contradictory when they are about different
things. A classification built from the names put `activity-health` and `activity-event` in
the same tier three times.

**Read `activity-` as a prefix that means nothing.** The tier is decided by what consumes the
message and whether it keeps it — storage, an index, a query path, or anything that changes
behaviour means durable; a component that repaints means disposable. `jsonl-index` looks like
plumbing and feeds *search*, so it is durable for the same reason.

## `machine_id` on a `resolveRpc` result — `server/unified-server.mjs`

**It holds the whole daemon key, `<machine>:<env>`, not a machine id.**

Every one of its twelve callers passes it straight to `sendDaemonDurable` /
`sendDaemonEphemeral`, which key `daemonConnections` on the joined form — so the value has
always been correct and only the name is wrong. It was already the joined key before
`projectAgentDaemonRoute` stopped splitting `daemon_key` into `machine_id` and `env_name`;
that change made the lie visible rather than causing it.

Not renamed because a rename touches twelve call sites in a live routing path for no
behaviour change. Read it as `daemon_key`.

**Its two siblings are gone.** `daemon_address` and `env_name` were on the same result object
and nothing read either — `grep -rn '\.daemon_address'` returned zero across the tree, with
`.machine_id` returning many as the positive control.

## `sha256` in a source manifest — `server/lib/source-git-store.mjs:241`

**It is a git blob id, which is a SHA-1.** `readManifest` returns
`{path, sha256, size}` and the value comes from `git ls-tree -l`, so it is the
object id git computes as `sha1("blob <length>\0" + bytes)` — the number
`git hash-object` prints. `shared/git-blob-id.mjs` computes the same value and
says so in one line: `createHash('sha1')`.

**The field is load-bearing in three places at once** — server manifests carry
it, the daemon compares files on disk against it, and the replica payload keys
its bytes by it. `acceptRevision` also takes it as `file.sha` to name an
unchanged file without sending its bytes, so the same number appears under two
names in one call.

**The hazard is not the hash choice, it is somebody reconciling the name.** A
reader who takes the field at its word writes `createHash('sha256')` somewhere,
and then every untouched file reads as changed on both sides — which is a
whole-project push, which is how passages get deleted. That is the failure
`shared/git-blob-id.mjs` exists to prevent, and its own comment points here.

**Not renamed because the string is stored in existing manifests and payloads**
rather than only passed between functions. A rename is a data migration; the
entry costs nothing and stops the next person inheriting it.

## `fleetStoreQueue.waitMaxMs` / `waitMeanMs` — `server/lib/fleet-store-client.mjs`

**What the name says:** how long a call waited in the queue in front of the single-threaded
store worker.

**What it measures:** enqueue to settle. `performance.now() - waiter.queuedAt` in
`_recordSettled` (`:190–201`), where `queuedAt` is stamped at enqueue (`:168`) and
`_recordSettled` runs when the call resolves. **It includes the call's own execution time.**
Total latency, not time-behind-someone-else.

**The cost, already paid.** `getAliveAgents waitMaxMs 24,979 ms` was read as *`getAliveAgents`
waited 25 seconds behind a slow query*. It is equally consistent with *`getAliveAgents` itself
took 25 seconds* — a different defect with a different owner. On 2026-08-22 a chief of staff
built a hypothesis on the first reading and staffed against it.

**The property is useful once you know it,** which is why this is an entry and not a rename.
Because the number includes execution, a method's recorded maximum is a **lower bound on the
longest it has ever run** — so a call whose maximum is 15.1 s cannot have held the worker for
25 s. That test is how `searchAll` was excluded as the blocker for the three largest stalls in
the same session.

**Also misleading:** the doc comment above `queueStats()` (`:203–213`) describes `oldestWaitMs`
as *"how long the one at the head has been waiting"* — correct for `oldestWaitMs`, and it reads
as though it governs `waitMaxMs` too. It does not. `oldestWaitMs` and `depth` are live and
correctly named.

**Repaired by renaming to `latencyMaxMs`/`latencyMeanMs`**, not by changing the measurement.

## `fleetStoreQueue.maxDepth` — `server/lib/fleet-store-client.mjs:186`

`if (this._pending.size > q.maxDepth) q.maxDepth = this._pending.size` runs inside
`_recordQueued`, so depth is **sampled only when a call is enqueued**, never on settle.
`_pending` holds calls waiting *or running*.

Two consequences. It is a lifetime high-water mark that **never resets** — like `waitMaxMs`,
so it cannot fall to evidence a fix, and after a restart it sits at the worst moment since boot
forever. And it is blind between enqueues: if the worker blocks while nothing new arrives, the
depth during that block is never sampled.

**It is sound as an upper bound**, which is the one thing it is good for — every enqueue
samples, so no moment's depth exceeded the lifetime maximum.

## `resource-cleanup.mjs` — a footprint cap, not a reclaimer

**What the name says:** something that reclaims disk.

**What it does:** caps one consumer's footprint. `:206` is the entire eviction decision —

```js
for (const entry of measured.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
  if (retainedBytes <= budgetBytes) break
```

`budgetBytes` is `DEFAULT_WORKTREE_NODE_MODULES_BUDGET_BYTES = 50 * 1024 ** 3` (`:11`);
`retainedBytes` is the summed size of `node_modules` under `/Users/skip/worktrees` only.
**`df` is never called. Free space appears nowhere in the module.** So the loop breaks on its
first iteration whenever worktree `node_modules` total is under 50 GiB, correctly, at any
free-space value including zero. A full volume is not a state it can perceive.

**The cost, 2026-08-22.** The volume reached zero with the fleet unable to run any command.
Several agents and a chief spent hours on *"why is the reclaimer not reclaiming"* before anyone
read the module. It was never a disk-pressure reclaimer; nobody had checked.

## `createPlaywrightPoolCleanup` — reaps processes, never their profiles

Reaps idle browser **processes** on `emptyIdleMs`/`unhealthyIdleMs`. It never deletes a user-data
directory, so `ms-playwright/daemon/ud-*` profiles accumulate permanently. Measured 2026-08-22:
19 stale profiles, oldest from June, **2.65 GiB**, with no browser process running.

Same shape as the entry above — a cleanup that cleans something other than what its name
implies — and in a place no pref-key or disk-usage search surfaces.

## `projectForCwd` — `shared/project-for-cwd.mjs:33`

**What the name says:** look up which project a directory belongs to. A map read.

**What it does:** up to **97 synchronous `git` process spawns**, blocking the caller's event
loop for the whole time. `gitRootFor` is `execFileSync('git', …)` with no memoisation, and it is
called from inside an `Array.filter` callback — once per entry in
`source-bindings.<env>.json`, which had **96** entries on testing when this was measured. Measured on
the mini 2026-08-22: a single spawn costs **0.33–2.68s of wall time for ~0.01s of CPU**, so the
call ran for **minutes**. That is what "agents cannot log in to the server" was: `login()` calls
it through `loginRouteFields()`, and `chat()` reaches it through `getAgentDoc()` whenever the
macro cache is cold.

`ea126fe91`'s successor memoises the lookup **per invocation**, so the 96 spawns become one. The
name still understates the cost — it is two `git` spawns, not a map read, and it is synchronous.

**And the deeper defect the memo hides, which is the reason this entry exists rather than just a
commit message.** The function reads each binding's value as a path — `resolve(String(dir))` at
`:41`. **Not one of them is a path.** They are objects:

Measured with `node`, which is the only instrument that answers this — Python's `str()` on a
dict gives a per-object repr and reports the values as all-distinct, which is the opposite
conclusion:

```
entries: 95            (the file changes as projects link and unlink; it was 96 an hour earlier)
value keys:            ['bindingId', 'project', 'sourceDir']
values that are plain strings:  0
distinct String(value): 1  ->  ["[object Object]"]
```

**Every entry, whatever the count that day, stringifies to the same `[object Object]`.** So the
containment test at `:51` can never match, and `gitRootFor` is handed the same nonexistent
directory once per entry. **`projectForCwd` cannot return anything but `null` on this machine,
and has not.** The file's shape and its only consumer
disagree; the memo makes that fast rather than correct.

**Fixing it is a behaviour change, not a cleanup.** Reading `sourceDir` turns project attribution
on login from always-`null` into actually-computed, which changes what agents report about where
they are — visibility, and Skip's call. Held on 2026-08-22 for that reason, not because it is
hard. Delete this paragraph in the commit that fixes it.

---

## `parseDurationMs` — two of them, and they disagree

**`shared/inbox-attention.mjs` and `src/App.tsx:647` both parse "the unit-bearing duration",
and they are not the same grammar.** The name is the same, the notation is nominally the same,
and the answers differ on two thirds of the inputs anyone would try.

Measured 2026-08-22 by running both — the frontend function lifted from its own source with
only the type annotation stripped, the server one through `parseBatchWindowMs`:

| input | `src/App.tsx` | `shared/inbox-attention.mjs` |
|---|---|---|
| `5` | **5** (means 5ms) | **null** (error) |
| `1.5h` | **undefined** | 5400000 |
| `5d` | 432000000 | **null** |
| `2w` | 1209600000 | **null** |
| `15 seconds` | **undefined** | 15000 |
| `0s` | **0** | **null** |
| `5s`, `500ms`, `2m` | agree | agree |

**The first row is the one that matters, because it violates a rule this project states
explicitly.** `AGENTS.md` §"Notation is borrowed, and so is its meaning" gives `batch(15s)` as
borrowed from CSS durations, and rules: *"The unit is part of the value. A bare `15` is an
error, not a default."* The server enforces that. **The frontend silently reads a bare number as
milliseconds** — the exact "default in some unit you have to guess" the rule exists to forbid.

The rest is ordinary drift in both directions: the frontend has `d` and `w` and no decimals or
long unit names; the server has decimals and long names and no `d` or `w`.

**Not fixed, and the reason is worth stating:** unifying them changes what the frontend accepts,
which is a behaviour change on inputs users may already be typing — a bare `5` currently *works*
there and would start erroring. That is a product call, not a cleanup, and it is the shape
`AGENTS.md` §"The three things he found in four days of our work" names as a product decision
taken as a maintenance chore.

**If you are about to add a third:** don't. Import one of these two, and if neither will do,
fix the one that is closest rather than growing the set. Delete this entry in the commit that
unifies them.

---

## `\includegraphics{fig.svg}` — the one include form an SVG figure does not accept

**An SVG figure is included as `fig.pdf`, or extensionless where the extension list allows
it. Writing `fig.svg` — the name of the file that actually exists — is the form that fails.**

The build compiles to DVI, and DVI-mode `latex` can read only an EPS bounding box, so every
format needs a `\DeclareGraphicsRule` mapping it to the `.bb` sidecar. `PRETEX` in
`server/lib/build-runner.mjs` declares one for `.pdf`, `.png`, `.jpg` and `.jpeg`. **There is
no rule for `.svg`**, so the include fails with `Cannot determine size of graphic … (no
BoundingBox)`.

The SVG path works by a redirection that hides this: `generateStubPdfs` writes `fig.pdf` and
`fig.bb` next to `fig.svg`, the document includes the *stub PDF's* name, and
`patch-svg-images.mjs` then swaps the real `fig.svg` back in — the `Using SVG fallback` line
in the build log. So the author writes the name of a file they never created, and the name of
the file they did create is the one that errors.

Measured 2026-08-22 on a throwaway project, same source, three include forms:

| include | result |
|---|---|
| `figures/vector` | `File not found` — `.pdf` is not in the extension search list |
| `figures/vector.svg` | `Cannot determine size of graphic` |
| `figures/vector.pdf` | builds, and renders the real SVG |

**This is pre-existing and not a regression** — it fails identically before and after the
raster-figure work of `a23a8bb9b`, which added the three raster rules and deliberately left
`.svg` alone.

**Fixing it is one line** — `\DeclareGraphicsRule{.svg}{eps}{.bb}{}` in `PRETEX` — because
the sidecar `generateStubPdfs` already writes is exactly what that rule would read. It was
not done because it changes an existing, working path and nothing in front of us needed it.
Delete this entry in the commit that adds the rule.


## `{{att:N}}` — a file shared between agents arrives as the placeholder

**Measured 2026-08-23 06:22, message id `3232097`.** An agent sent a readable
absolute path in a chat message. The stored event text is the literal marker
`{{att:0}}`, and the recipient — another agent — saw exactly that: not a chip and
not the path. A second agent-side reader (`search`) shows the same raw token.

**The placeholder itself is correct by design.** `shared/message-processing.mjs`
detects a path, uploads the bytes, and substitutes the marker; the real path and
the attachment live in the event metadata. The browser expands it in
`src/fleet/chat-render.mjs`, and **falls back to a paperclip chip when the
attachment cannot be resolved** — so a human never sees the marker.

**The agent side resolves it in `resolveInboxMessage`
(`mcp-server/fleet-tools.mjs`), and its last line is `return token`.** So where
the browser degrades to a chip, the MCP degrades to the raw internal marker. An
agent receiving a shared file gets a string that looks like a templating bug.

**What is NOT established, and it decides the fix:** whether the attachment
metadata was absent, unmaterialized for that reader, or present-but-unresolvable.
All three land in the same `return token` branch and are indistinguishable from
outside. Establish which before changing the fallback.

**Seen at least twice the same night** — the message above, and hours earlier a
build report in which a LaTeX *file not found* error named the marker instead of
a filename, because the substitution had replaced a path inside quoted tool
output. That is the cost: the report read as the compiler complaining about the
marker itself.

**Do not "fix" this by making the sender stop substituting.** The placeholder is
what keeps the path and the uploaded artifact associated. The gap is the
agent-side fallback, and possibly the materialization behind it.
