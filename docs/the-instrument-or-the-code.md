# The instrument, or the code

**A measurement that comes back empty, slow, or failed is a claim about two
things at once — the subject, and the thing doing the measuring.** Most of the
time the instrument is fine and the reading is about the subject. When it is
not, the reading still looks exactly like a finding, and it is usually a
*serious* finding: an outage, a hang, a regression, a feature that was never
built.

**Nine of these happened in one night — 2026-08-18 into 2026-08-19 — across at
least three agents.** Every one reported a defect in a path that was working.
Two were minutes from being relayed to Skip. This page is the shapes they take
and the checks that separate them, written down because the cost is not the
wasted hour: it is that a false finding sends somebody to *fix* a working path.

**The shapes below are no longer only that night's** — later ones carry their own
dates, and the numbering is not a count of that night's nine. Do not read the
last entry as the ninth incident.

**This is the same disease as [Naming errata](naming-errata.md) one level up.**
There, a name lies about what code does. Here, a measurement lies about what the
system did — and unlike a name, it lies in a form that looks like evidence.

## The shapes

### 1. A bound set against a quiet box

**A timeout is a claim about how long something should take, and it was written
on a machine that was not this machine.** Under load it fires, and it does not
report *"my patience ran out"* — it reports whatever the caller says when it
gives up, which is almost always the language of a defect.

| measured | bound | actual | would have been reported as |
|---|---|---|---|
| `a-source-change-that-proposes-instead-of-pushing` | 10s | 7.3–8.8s, five runs, load avg 52 | *the daemon's proposal path does not reach the server* |
| the "~50% hang" in the build path (`pm-sync`) | 10s | 8–9s; at a 60s bound, **0 of 6** timed out | *the accept hangs half the time* — a fleet-wide stop-the-line |

**The tell is a pass rate that moves with the box rather than with the code.**
Green alone and red in a sequential suite is not flakiness to be re-run; it is a
bound with no headroom.

**The check:** time five green runs and compare the spread to the bound. If the
slowest is within ~2× of it, the instrument is measuring the machine. Widen the
bound; never touch the assertion.

### 2. A true number about the wrong subject

**The measurement is correct and it is about something else.** This is the most
convincing shape on this page, because nothing about the number looks wrong.

- **2026-08-18** — the gate for restoring a bot to supervision was *"`ps eww` shows
  four `TLDA_DEV_BOT_*` matches, not zero"*. It read as **met** the whole time.
  The four matches were on a **hand-launched** process with `PPID 1`, started
  before any supervised attempt. The measurement was accurate and it was about
  the workaround.
- **the same night** — both bots reported up to Skip on the strength of `.log`
  files last written in July. A file that exists and parses is not a file that is
  current. (See [Naming errata](naming-errata.md) §`~/.config/tlda/<bot>.<env>.log`,
  which is a different lie about the same files.)

**The check:** before reading a process's environment, establish *which process*.
A workaround usually runs alongside the thing being fixed and will happily answer
the question you meant to ask about the other one. Discriminate by parentage or
start time — a supervised process is a fresh pid whose parent is the supervisor,
not `init`. For a file, read its mtime before its contents.

**2026-08-23 — the same shape with a file instead of a process, four times in one
night.** Each person read a real file, reasoned correctly about it, and was
describing a copy that does not run:

| who | read | asserted about |
|---|---|---|
| chief | `shared/latex-deps.mjs` | the live closure walk — that module has **one** occurrence in the tree, its own test |
| chief | `bin/websocket-boundary-guard.mjs` allow-list | a count that its own author's later deletion had already falsified |
| `notify-ship` | `latex-deps.mjs` line numbers | the live path, independently, minutes apart from the chief |
| advocate | `tlda-fork-swap`'s `dev-bot.mjs` | production — while enforcing the tree-naming rule on someone else |

**This is not four discipline failures.** A repository with a dozen worktrees of
the same file makes "the copy I opened" and "the copy that runs" indistinguishable
at a glance, and `git grep` without a ref reads whichever branch the checkout is
sitting on. **The path of least resistance produces the error.**

**The check, and it is two commands:** name the ref (`git grep <literal> main`),
and count production callers of the entry point before changing it — with a
known-live sibling as the control. On 2026-08-22 that check was the only thing
that stopped a fix landing in a module nothing calls, where every test would have
gone green.

### 3. A zero from a query that cannot return anything else

**An empty result from a broken query and an empty result from an empty world are
the same characters.** Neither errors. Both answer.

- **2026-08-18** — a search for an agent's recent session rows returned nothing,
  and the conclusion nearly drawn was *the session ingester has stopped fleet-wide*.
  One query without the role filter returned rows immediately: the filter meant
  something other than assumed and nothing was stalled.
- **2026-08-19** — a spawn-count probe monkeypatched `child_process.spawn` and
  measured **0 spawns**, which would have meant the blob writes were already
  batched. Named imports bind at module load, so the patch could not have been
  observed. The real count was one per file.

- **2026-08-22** — a raw `login` sent over `/ws/fleet` to prove the server was
  hanging got **no reply in 25 seconds**, while the socket streamed broadcasts
  the whole time. That reads as *the server accepts logins and never answers
  them*, which was about to be reported. The correlation field is `id`; the
  probe used `request_id`. Re-sent with `id`, the same server answered the same
  login in **322ms**. The field is set in `_sendWSOnce` — find it there rather
  than guessing, and note that a request with an unknown correlation key is not
  rejected, it is simply never matched, so the socket stays healthy and silent.

**The check — a positive control, and it is one command.** Run the same query
against something you *know* is there. If that also comes back empty, the
instrument is broken rather than the world.

### 4. A control that could not have failed

**Shape 3's own remedy has this failure mode, which is why it gets its own
entry.** A control only controls if it would have produced a different answer.

- **2026-08-19** — a doc was checked for a figure by grepping for `1492` as the
  positive control. It returned 0. The number was in a *commit message*, not the
  document — the control had been chosen from memory of writing it, so its
  absence proved nothing about the instrument.
- **2026-08-19** — `git merge-tree --write-tree <branch> <its own ancestor>`
  returned exit 0 and was nearly reported as *"the branches merge clean"*.
  Merging an ancestor **cannot** conflict. Rebuilt as two branches editing the
  same line, the command returned exit 1 — only then did the exit 0 on the real
  pair mean anything.

**The check:** state what the control would look like if it *failed*, before
running it. If you cannot, it is not a control.

### 5. A failure after the verdict was already in

**The subject passed and the harness failed anyway**, and what the runner reports
is the harness.

- **2026-08-19** — `a-fanout-that-carries-the-words` exited non-zero on
  `ENOTEMPTY`. **Every assertion had already passed**; post-accept effects were
  still writing into the temp directory while `rmSync` walked it. In a suite it
  reads as *the fan-out corrupts state* — a data-loss finding, in the one path
  where data loss is the thing being guarded.

**The tell is that the error is in the vocabulary of the harness — a filesystem
errno, a port in use, a cleanup — rather than of the thing under test.**

**The check:** read *which* assertion failed before believing the exit code. If
none did, the finding is about teardown and belongs nowhere near the subject.

### 6. A true number that cannot see the thing you are asking about

**`%CPU` cannot detect a blocked event loop, because the most common way to block
one costs no CPU at all.**

- **2026-08-22** — chasing multi-minute `login()` and `chat()` hangs, I measured
  the MCP process at **4.5 seconds of CPU across 30 minutes** and concluded it
  was not compute-bound but waiting on I/O. The measurement was correct and the
  inference was wrong. The process was blocked in `execFileSync` — **96
  synchronous `git` spawns**, each costing 0.3–2.7s of *wall* time for ~0.01s of
  CPU. The event loop was fully blocked the entire time and the process looked
  idle, because **spawn latency is not computation.**

**The tell: "not compute-bound" and "not blocked" are different claims, and only
the first one `%CPU` can support.** Anything that blocks on a syscall — a
synchronous spawn, `readFileSync` on a slow volume, a sync SQLite write — is
invisible to it and produces exactly the reading a genuinely idle process does.

**The check:** `sample <pid>` and read the stack. `notify-ship` got the answer in
one shot that way — 179 of 179 samples showing `Builtins_ArrayFilter →
SyncProcessRunner::Spawn → uv__io_poll`, which names both the blocking call *and*
the loop it sits in. `%CPU` was never going to say that, however many times it
was read.

**This is the same failure as shape 2 one level down** — a true number about the
wrong subject — with the extra trap that here the number *is* about the right
process. It answers "is it computing", and the question was "is it stuck".

### 7. A fossil read as current state

**`argv` records what a process was launched with. It never changes, so it
answers a question about the past in the present tense.**

- **2026-08-22** — hunting the `login()` hang, I reported **five agents wedged at
  the identical `login()` prompt**, at 30m, 37m, 11h40m and 18h09m, from `ps`
  output matching that prompt. The prompt is in `argv` because the harness was
  *launched* with it. It is equally present on a process that logged in a minute
  later and has been working ever since. The counterexample was in the same list:
  pid 56152 carried the prompt and was "up 12h29m" — it is `sync-corruption-proof`,
  which the fleet broadcast showed `last_seen` **23:06:10Z**. Live, not wedged.
  Re-running the same query an hour later returned **12**, which is plainly not
  twelve wedged seats.

**The tell is a field that cannot change describing a state that does.** Process
uptime has the same shape: it measures the process, not what the process is doing
now. Compare [Naming errata](naming-errata.md) §`tmux` server `argv`, which is
this fossil in a different costume.

**The check:** ask what would have to be true for this field to be *updated*. If
nothing updates it, it is a record of a moment and the moment is not now. The
question "is this seat stuck" was answered instead by **which seats had a live
MCP behind them**, which is state that moves.

### 8. A green test whose name overstates its reach

**A test can be correct, pass, and say nothing about the machine you care
about** — and the name is what gets repeated.

- **2026-08-22** — `ack-timeout-config.test.mjs` is named *"every deployment
  declares an ack timeout, with a unit"*, and it passes. It enumerates
  `config/deployments/*` — which is `live`, `overleaf-test`, `pic`, `rc`,
  `stable` and `talk`. **There is no `config/deployments/testing/`, and `testing`
  is the environment Skip uses.** The value there comes from the in-code default
  instead, so the green test is not evidence about his box. Nothing is broken;
  the name simply claims a scope the enumeration does not have.

**The tell: a test that iterates a directory, a registry, or a glob asserts a
property of *what it found*, not of the set you had in mind.** The absent member
is silent by construction — this is shape 3 pointed at the input rather than the
output.

**The check:** print what the enumeration actually enumerated, and compare it to
the set you meant. See `AGENTS.md` §"A clean sweep is only as good as the set you
swept for", which is the same rule learned at greater cost.

### 9. A counter scoped to a population that excludes what it counts

**`totals.dead` in the fleet table is always `0`, and cannot be anything else.**
The totals are computed over the live rows, and a dead row is not a live row, so
the field counts a thing it has already filtered out.

Measured 2026-08-23 04:05, both numbers from the **same response**, an hour after
99 agents were deliberately marked dead:

```
env totals   {"awake":28,"hibernating":2593,"dead":0,"total":2621}
wholeFleet   {"total":39369,"live":3810,"dead":35559}
```

**35,559 dead, reported as 0, eight lines apart in one payload.**

**What it cost:** *"0 dead out of 2,720"* was used all night — twice to Skip and
once into a durable note — as evidence that **nothing had ever been killed**, and
therefore that the panel filling up was nobody's fault but the app's. That
inference was worthless: the field reads `0` whether nothing has ever been killed
or thirty-five thousand things have. The conclusion it supported happened to be
true, and was established properly only afterwards, from the code: the panel
hides a row only when `dead` is set, and `kill` refuses any agent with no daemon
route.

**The tell is a field whose maximum is structurally zero.** It is not noisy, not
stale and not slow — it is precise, instant, and incapable of the value you are
looking for. Same family as shape 3, but worse to spot, because nothing about a
crisp `0` next to `2621` suggests the two were computed over different sets.

**The check:** for any count you are about to reason from, ask what would have to
be true for it to be non-zero, and confirm the query can express that. Here the
same payload already carried the honest number.

### 10. Output edited between the tool and the reader

**An agent runs a command, quotes what it printed, and the quote is silently
rewritten before another agent reads it.** Not a wrong reading of a real output —
a real output, altered in transit.

**2026-08-23.** A build report quoted a LaTeX failure. What the recipient read
was a *file not found* error naming the attachment marker `{{att:0}}` rather
than a filename. The compiler never emitted that string: chat's path detection
had matched the filename inside the quoted block and substituted its attachment
placeholder, and the agent-side resolver left the marker raw. See
[Naming errata](naming-errata.md) for the placeholder mechanism.

**So "I ran X and it said Y" is not trustworthy whenever Y contains a path.**
Every other shape on this page is a reading that misleads; this one is evidence
that no longer matches what the tool produced.

**And the tell is that there is no tell — it reads as a typo.** The first
sighting was filed as odd formatting and moved past, by someone who then spent
hours on the same subsystem. Corruption that looks like corruption gets chased;
this looks like a stray brace.

**The check:** when a quoted tool output contains something surprising in the
*shape of a path or a filename*, go to the raw source — the log file, the
terminal, the stored event — before reasoning about what the tool said. And when
quoting output that contains paths, expect it to be rewritten and say where the
original can be read.

### 11. A confident clean number about a set the query was never looking at

**The query runs, matches, and returns. It just does not cover the population you
believe it covers** — a field that does not exist yet, a category whose members
are all legitimate, a type name the app has never had. Nothing is empty and
nothing errors, so none of the emptiness checks above fire. The answer is small,
tidy, and about a different set.

**Three of these in one night, 2026-08-23, from one agent, each about to be
reported as a finding:**

| the query | what it returned | what it was actually looking at |
|---|---|---|
| `edit_operation` present on `Edit`/`Write` blocks in the raw session JSONL | **0 of 725**, across 40 sessions | the field does not exist in the file. `parseSessionRecord` **synthesizes** it at parse time (`normalizedToolInput`, using the tool_use `id`). The events the daemon actually sees always carry it |
| html-page shapes whose id does not start with `shape:<project>-page-` — "legacy rooms" | **10 projects** | `-slide-N`, `--parts-page-N` and `spatial-document-*`: two other shape families and one deliberate namespace. Zero legacy rooms |
| annotations, matched as `math-note` and `note` | **47**, all healthy | **there is no `note` type in this app.** `highlight` (63), `geo` (124), `understanding-line` (10) were never counted. The real total is 253 |

**The first would have reported a working fix as useless.** The conclusion drawn
was *the harness never populates this field, so restoring the recording call
restores nothing* — one step from telling a chief to abandon a one-line repair
that in fact works.

**The tell is that the number is plausible.** 0 of 725 looks like a definitive
negative. 10 legacy rooms looks like a real backlog. 47 annotations, all
correctly parented, looks like a clean bill of health. **A number that looked
wrong would have been checked; these did not.**

**The check is the positive control again — but pointed at the query's
VOCABULARY rather than its result.** Before believing a count, enumerate what is
actually there: every `type` in the store, every key on the record, every value
the column takes. All three collapse instantly under that. The type census took
one command and turned 47 into 253.

**And the reason it has to come from outside the query:** two of the three were
caught because someone else asked *"positive-control that"* — not because the
author reviewed their own work again. **The author of a query is the worst-placed
person to notice it is asking the wrong question**, because the query is a
faithful expression of what they already believe the world contains. Re-reading
it confirms the belief. Only an instrument pointed at the belief itself — what
types exist, what fields exist — can break it. This is the same reason
`AGENTS.md` gives a chief of staff an advocate.

## The standing check, in one line

**Before reporting an absence, a hang, or a failure, ask what this instrument
would show if the system were healthy — and confirm it can show that.**

Every one of these passes that question trivially in hindsight and none of
them were asked it at the time. The reason is worth naming: **an instrument
failure and a serious defect produce the same reading, and the serious defect is
more interesting.** Attention goes to the finding, not to the ruler.

### 12. A monitor that flags designed behaviour as a fault

**The check runs correctly, reads real state, and reports a contradiction that
is not one** — because the premise in its own comment is wrong about what the
system does. It stays red for as long as the system stays in a state it was
designed to enter and hold.

**Measured 2026-08-26.** `dev-bot.mjs`'s `document-surfaces` check:

```js
// A build reported failed while the pages it supposedly failed to make are
// being served.
if (project.buildStatus === 'error' && built) { … }
```

Those pages are not the ones the build failed to make. They are the *previous*
good ones, kept on purpose — the server says so in the throw itself,
`server/lib/build-runner.mjs:200`:

```js
throw new Error(`LaTeX produced ${errors.length} error(s); keeping the last successful render`)
```

So `buildStatus: error` **plus** served pages is the documented success path of a
failed build: the author's last working render stays up instead of the document
going blank. There is a test asserting that message.

**Why this one is worse than noise.** It had fired unchanged for 236 minutes
naming four projects, two of them Skip's, so anyone reading it cold concludes his
papers are broken. And `document-surfaces` also carries the spinner check and the
`/macros` check, which are real — **a permanently-red alarm trains everyone to
ignore the report that contains the true findings.**

**The check that catches it: name the state the alarm is complaining about, and
ask whether the system enters it on purpose.** Not "does it fire on the bad
case" — this one fires on a real state, correctly detected. The question is
whether that state is a fault or a design. Here the answer was one grep away,
in the server's own error string.

**Be precise about the failure, because "it can never go green" would be
wrong.** This check does go quiet for a project whose build succeeds — 
`balancing-act` left the list between two sweeps by rebuilding clean. What it
cannot do is go quiet for a project that is *correctly* holding its last good
render, which is a state the system will sit in indefinitely and by intent. So
the alarm is not stuck; it is faithfully reporting a design as a defect, for as
long as the design holds.

### 13. Two instruments agreeing on an absence, because they share a blind spot

**Independent confirmation is the strongest evidence there is — except when both
instruments are the same kind of instrument.** Then agreement is not two
measurements; it is one measurement taken twice, and its blind spot is confirmed
rather than exposed.

**Measured 2026-08-26.** Two agents classified the same 43 checkouts for whether
they could still submit. The counts disagreed — 1 diverged against 6 — which is
what made the reconciliation happen, and the reconciliation found the real error:
one test compared `refs/tlda/project/<p>` (the chain) and the other compared
`HEAD`. **HEAD is the right one**, because the question is whether the working
checkout can push, and a chain ref can sit on the server's line while the
checkout the person types in has wandered off it. The chain-based test would have
cleared six checkouts that cannot submit.

**But both tests returned the same 21 "no refs to compare", and both were
silent on them.** Two independent agents, agreeing, on a fifth of the
population — and the agreement was worthless, because both instruments were
git-local and the missing refs were exactly what git-local cannot see past.

**One HTTP call to the server resolved all 21**, and split them three ways:
fifteen were bindings to projects that do not exist, three had a server-side
revision with no local record of it, three had never synced. Three different
dispositions, one of which — server ahead, local blind — is the shape where a
repair overwrites.

**The check: when two measurements agree, ask whether they could disagree.** If
both read the same store, the same log, the same tree, agreement tells you
they are consistent, not that they are right. **Reach for an instrument of a
different kind** — the server when you have been reading git, the wire when you
have been reading code, his screen when you have been reading the wire.

**The disagreement is the useful event.** The chain-versus-HEAD error was caught
*because* the numbers conflicted. Nothing caught the shared 21 until somebody
asked a question neither query could answer.

### 14. A reading taken before the state settled

**A terminal, a DOM, a rendered pane: the state changes when the code acts, and
the picture of it catches up afterwards.** So a check that acts and then
immediately reads is not measuring the state; it is racing the renderer to it.
And the race is not symmetric: the thing that has not appeared yet is the
*effect of the fix*, so the stale frame shows the world as it was before, which
is the world with the bug in it. **An instrument that samples too early reports
the wrong state, and it reports it in the direction of the bug you are hunting.**

**Measured 2026-09-12**, on a harness written to answer whether a launch had
left an agent's kickoff parked unsent in its `codex` composer. The harness
captured the pane the instant the injector returned. The injector's *last act*,
when it gives up, is a `C-u` to clear that composer — so the read and the clear
were in flight together, and a composer that had been cleared correctly could
still be holding the kickoff in the frame that was read. Every such reading
scores as the defect.

**How much it corrupted was never isolated**, because a code fix landed in the
same window; what is certain is that the race was there by construction and that
its error only ever runs one way. That asymmetry is the reason it deserves an
entry: a noisy instrument wastes runs, while a *biased* one confirms whatever it
was built to look for.

**The check: settle, then read — and prove the settle is doing work.** Take the
reading twice, once immediately and once after a delay, and compare. If they
differ, the delay is load-bearing and the immediate reading was never evidence.

**That check is not what happened here.** 900ms was *chosen*, and the false
readings stopped; the renderer's actual latency was never measured, so the delay
is known to be sufficient on this box at this load and not known to be
sufficient anywhere else. The number is a property of the renderer rather than of
the code under test, which is exactly why picking one is a weaker position than
measuring it.

**Do not reach for a retry loop instead.** Polling until the pane says what you
expect is this shape with the bias made explicit — it terminates on the answer
you wanted and times out on the other one.

**Related, and a different entry:** the *rate* this harness measured also moved
with load, because the failure window it was sampling is bounded by how fast the
harness starts. That is shape 1 above, and the two compound — a bound measuring
the machine, sampled by a reading that beats the renderer.

### 15. An instrument that discards the one bit that answers the question

**The reading is complete, correct, and stripped of the only thing that would
have distinguished the two states you were choosing between.** This is not a
measurement that lies about its subject; it is a measurement that has been
lossily re-encoded on the way to you, and the loss is invisible because what
arrives looks exactly like a full answer.

**Measured 2026-09-12**, over about ninety minutes. Text was sitting next to the
prompt in a couple of dozen agents' composers — the counts quoted during the
night were themselves in dispute, which is part of the story. The question was
whether it was **pending input nobody had submitted** or a **dim ghost over an
empty buffer**, and those have opposite consequences: the first means
instructions are being dropped invisibly, the second means nothing is wrong.

`tmux capture-pane -p` **strips the attributes.** Dim is an attribute. So the two
states arrive as the same bytes, and each account built on that reading was an
account of a coin whose faces had been sanded off:

| what was concluded from the stripped capture | fate |
|---|---|
| nineteen agents are holding undelivered instructions | withdrawn |
| it is placeholder text, nothing is stuck | withdrawn |
| it is the last submitted input echoed back | withdrawn |

**A fourth account that night — that a notification path was failing to land its
`Enter` — is deliberately NOT in that table.** It was withdrawn too, but on the
ground that the path is unreachable from the harness in question, which is a
code-reading error rather than an instrument one. Counting it here would have
made this shape look responsible for more than it is.

**`capture-pane -p -e` keeps them, and then it is one grep.** Three states, not
two, which is the part that made the original count a sum rather than a quantity:

```
ESC[2m …            dimmed foreground   -> ghost, buffer EMPTY
ESC[38;5;246m …     grey foreground     -> ghost, buffer EMPTY
ESC[48;5;237m …     highlighted block   -> a genuinely QUEUED, unconsumed prompt
```

**The tell is that you are choosing between two states and your instrument has a
lossy stage in it.** Not a broken stage — a *lossy* one, which is why nothing
errors and nothing looks empty. Ask what the transport drops: attributes, colour,
timing, ordering, duplicates, whitespace. Then ask whether the bit that separates
your two candidates is in that list.

**And the cost is paid by whoever reads the conclusion, not by whoever ran the
check.** Three explanations went out to a fleet, each consistent with the
evidence available, each produced in minutes. The evidence was not wrong. It was
incomplete in exactly the dimension the question turned on, and nothing about it
said so.

**The check: before believing a two-way discrimination, reproduce both sides
deliberately and confirm your reading separates them.** Type the text and look;
clear it and look. If both look the same, the instrument cannot answer the
question however many times you run it — and running it again is what the
withdrawals above have in common.

### 16. A correct reading that licenses the wrong action

**A pane-content match and a keystroke target are different addresses.**
`notify-does-not-wake`, 2026-09-12, and the sentence is the whole shape. Most of
this page is about a reading that misleads. This one is about a reading that is
correct *and* correctly interpreted, where the failure is entirely in the step
after it — a true answer to one question spent as though it answered another.

**This is shape 2 with the subject one layer further out.** There, a true number
was about the wrong *thing*. Here the reading is about the right thing, and the
**action** it authorises reaches somewhere else.

**Measured 2026-09-12.** A recovery for agents whose kickoff sits unsent read the
composer, matched the kickoff, and sent `Enter`. The classifier was verified
correct — the matched span really was the queued kickoff, checked before the
report was raised. But **`Enter` goes to whatever has focus**, and the probe
carrying those queued prompts also had a dev-channels dialog up, with
`1. Yes, I trust this folder` as the highlighted default. The match was sound
and the keystroke would have answered a trust prompt.

**Nothing in the classification was wrong, which is what makes it hard to see.**
A wrong reading eventually contradicts something. A right reading pointed at the
wrong address contradicts nothing, and every check you run on the reading itself
comes back green.

**The tell: a check that produces a FACT is being used to authorise an ACT, and
the two live at different addresses.** Content against focus. A row exists
against a lock you hold. A file is present against a file you may write. A
process is alive against a process that will answer. Each pair looks like one
question and is two.

**The check: name the address your evidence is about, and the address your action
reaches. If they differ, you need a second observation scoped to the second
address, taken immediately before acting** — not a better version of the first.
Here that is a focus-scoped refusal: is anything awaiting a keypress, coarsely,
any dialog recognised or not. Recognising them one by one is the enumerating
failure this page's neighbours already record.

**And the honest part of this entry: the rule was already known and written down
by the person who broke it.** The same author had refused, hours earlier, to
auto-answer dialogs a launcher cannot read — on the ground that the highlighted
default might be exactly that trust prompt — and then wrote a content match with
no focus check. **A ruling binds the plan and not the code unless something in
the code enforces it.** It was caught before it ran only because the process that
would have executed it had not been restarted, which is timing rather than
design.

### 17. A guard that exists and never runs, four layers deep

**2026-09-12.** `main` was unbuildable twice in one day, hours apart and from
different lanes — `src/App.tsx` importing a file that was never committed, and
`src/katexMacros.ts` typing the KaTeX macro map as `Record<string, string>`
while `shared/katex-base-macros.mjs` kept adding function macros. Both compile
for their author, whose disk holds the missing half. Three lanes landed on top
of a red tree and none of them could have known.

**Nothing compiled `main` between a landing and a deploy.** The deploy did, and
reported 26–76 minutes later by rejecting somebody else's push — so whoever
learned about a break was never whoever caused it.

**The remedy was a `post-merge` hook that compiles `main` and says so. It went
wrong four times, and each layer looks fine from the layer above.**

1. **The check was never installed.** It sat on `main` as a source file.
   `bin/git-hooks/` is a source directory; `.git/hooks/` is where git looks.
   **Landing a hook is not installing it, in the way merging a commit is not
   deploying it.**
2. **The installer could not install it.** `bin/install-git-hooks.sh` used
   `$REPO_ROOT/.git/hooks` — and in a worktree `.git` is a **file** pointing at
   the real gitdir, so `cp` failed with `Not a directory`. It only ever worked
   from the canonical checkout, which is the one place nobody works, because
   that is where someone else is standing.
3. **Once installed, it listens for an event this repository does not use.**
   `post-merge` fires on `git merge`. `main` advances here by `git update-ref`
   from a detached worktree — a workaround for the shared checkout, which
   silently disabled the fix for the other problem. The hook was present,
   installed, executable, and structurally unable to fire.
4. **And the same `.git`-is-a-file bug was inside the check itself**, writing
   its status file to a path under a file. That one was caught by a
   deliberate-failure test before landing; the other three were not.

**Every one of these reports healthy by being absent.** No error, no red,
nothing to notice — the shape this page opens with, where a grep finds a call
that is present and can never find one that is missing.

**What distinguishes the layer that was caught from the three that were not:**
the failure control ran the thing and watched it fail. The others were verified
by looking — the file is on `main`, the installer exited, the hook is in
`.git/hooks` and executable. **"Show me it fired on a real landing" and "show me
it is installed" are different questions, and only the first one has ever caught
any of this.**

**Two facts worth keeping, both measured rather than assumed:**

- **Hooks are per-clone, not per-worktree.** All 838 worktrees here resolve
  `--git-common-dir` to one `.git`, so installing once covers every one of them.
  **Separate clones do not share it**, and several exist on this box. So
  "installed" is a statement about a clone, not about the repository.
- **The trigger question is still open, and honestly so.** `reference-transaction`
  fires on any ref update including `update-ref`, which is the event that
  actually happens here — but I could not run the experiment to establish
  whether it fires once per landing or once per ref per phase, and **a hook that
  fires three times per landing is its own problem.** Recorded as a candidate,
  not a finding. A fast answer here would be the fifth layer.

### 18. A declaration read as a description of what is running

**A config file says what a process *should* have been given. Nothing in it
reports what the process actually got**, and the two drifted here for twenty
days without a single surface saying so.

`~/.config/tlda/bots.yaml` gives `dev` an `env:` block, and the load-bearing
entry is `TLDA_DEV_BOT_DISABLED_CHECKS` — seven checks held out, each with a
written reason above it, three of them the probe checks Skip ordered removed on
2026-08-23 for minting a live agent per sweep.

**The running process had none of the five variables.** `ps -p <pid> -wwwE`
showed `TLDA_BOT_NAME`, `TLDA_BOT_PIDFILE`, `TLDA_BOT_HEARTBEAT`, `TLDA_ENV` and
the `FLEET_*` set, and nothing from the declaration. So all seven ran, and their
combined failure summary — 43,873 characters — is what got the bot renamed inert
as a runaway.

**Every instrument in reach agreed the config was fine, because every one of them
read the file rather than the process.** The declaration parsed. The resolver,
called by hand, returned all five values correctly. `tlda bot status` reported
the bot running. The bot's own heartbeat recorded which checks it ran, and
nobody compared that list against the declaration.

**What made it survivable is that the drop was at a call site neither end owned.**
The stored `launch_recipe` for `bot:testing:dev` was created 2026-07-25 and still
carried five of the six launch keys that `ca5d89397` later deleted from the
design — every one except `botEnv`, which is the one that mattered.
Because it supplied `botScript`, `agent-launch` took its explicit-caller branch
and never consulted the declaration at all — so a *newer* commit's cleanup was
undone by an *older* row, and both halves looked right in isolation.

**The check: ask the process, not the file.** `ps -wwwE <pid>` against the `env:`
block is two seconds and it is the only thing here that could have gone red. A
declared setting is a claim about a launch that already happened, and the launch
is the only witness.

### 19. A true status that describes the wrong event

**`git status` reported two files staged with fifty-nine deletions, exactly
undoing a commit that had just landed. Every line of it was accurate and nobody
had touched anything.**

`refs/heads/main` was fast-forwarded with `git update-ref refs/heads/main <new>
<old>`. That is the careful form — the old-value argument makes a concurrent move
fail rather than clobber. But it moves the **ref**, and another worktree had
`main` checked out. Its HEAD follows the ref; its index and its files do not.
The gap between them is the landed commit, and `git status` renders a gap as
**staged modifications**.

**So the instrument depicted an author.** Staged, not merely modified — someone
ran `git add`. Two files, both in one subsystem. A coherent revert of a specific
commit. There is no reading of that output that says *nothing happened*, and the
chief of staff who found it drew the only available conclusion: another
contributor has work in progress here, and it is not mine to disturb. **That
judgement was right, and it would have left the state untouched all night.**

**Three other agents were blocked behind it**, because `main` being checked out
in that worktree is what refuses the fleet's pushes — which is how a
cosmetic-looking discrepancy bought a night of blocked landings.

**The check is to compare content against the commit's PARENT, by hash:**

```
git show <parent>:<path> | shasum        # against
shasum < <path>
```

Byte-identical to the parent means the worktree is merely stale, the content is
already on the branch, and `git checkout HEAD -- <paths>` loses nothing. Both
files matched exactly. **A diff cannot answer this question**: a diff describes
the same gap the status did, so it re-reports the appearance rather than testing
it. A hash against a named commit asks where the bytes came from, which is the
thing actually in doubt.

**One more instrument failed here before the right one worked.** A `sed`/`sort`
pipeline comparing the two diffs answered *"NOT an exact inverse — do not
touch."* That was the pipeline being wrong, not a finding, and it pointed the
same direction as the misleading status. **Two agreeing instruments were both
reading the appearance**; only the hash comparison addressed the cause.

**And cleaning the tree does not unblock the push.** `receive.denyCurrentBranch`
unset refuses a push to a checked-out branch **whether or not the tree is
clean**. The staleness and the refusal look like one problem and are two, and
repairing the visible one would have produced a clean tree that still rejected
every push — a fix that appears to work and changes nothing.

**The general shape: an instrument that is accurate about state can still be
describing a different event than the one you infer.** `git status` reports a
difference; it does not report who made it or when, and the words it uses
—"staged", "modified" — name actions. The event here was a ref moving under a
directory, which has no vocabulary in that output at all.

### 20. A walk that navigates to the machine's own hostname, because `zsh` got there first

**Four assertions came back red — `RED: no roster cells`, `RED: no titled chip`, `RED: no
status chips` — against a server that was serving correctly the whole time.** Measured
while the reds were being produced: root `200` in 0.67s, the API `200`.

Every navigation had gone to `https://mini.local/`, which serves nothing. The script said:

```sh
: ${HOST:=https://localhost:5179}
```

**`zsh` presets `HOST` to the machine's hostname**, so the `:=` default never fires and the
variable a reader sees assigned is never the value used:

```
zsh -c 'echo $HOST'                                    → mini.local
zsh -c ': ${HOST:=https://localhost:5179}; echo $HOST' → mini.local
```

**The page stayed `about:blank` and every DOM query was therefore true and meaningless.**
This is §"they set up environments in which nothing happens and then are like, oh, nothing's
happening" arriving through a variable name rather than a missing fixture — and it reads
worse than a crash, because four independent-looking assertions agree.

**`HOST` is not special; it is the one that has bitten us.** Checked with `zsh -f`, so this
is the shell rather than anything in Skip's config: `PATH`, `PWD`, `OLDPWD`, `LINES`,
`COLUMNS`, `RANDOM` and `SECONDS` are preset too, and any of them used as a script parameter
has the same silent-override shape. **Prefer a name nothing else
owns** — `WALK_HOST`, `TARGET_URL` — and, before believing a red, **assert the page is not
`about:blank` and print the URL the browser actually landed on.**

### 21. A capture verb that reports nothing and writes nothing

**A five-step walk ran twice and produced zero pictures, while reporting `done`.**

```sh
tlda-dev pw screenshot scratch/walk-frames/1-roster.png
```

`screenshot`'s first positional argument is a **target selector**, not a path; the path goes
in `--filename`. So each step errored with `Unexpected token "" while parsing css selector
""` — a message about CSS, in a walk about glyphs, easy to read as noise from the page — and
wrote no file. **Three separate walk scripts written that night carried the same call.**

**A picture is the deliverable of a walk, so this is not a cosmetic defect: it is the whole
output silently missing.** `ls` the output directory after a capture. A verb's exit status
describes the verb; only the file describes the frame.

### 22. A walk that loses a step to a lock and prints `done` anyway

**The last step of the same walk never executed.** Another agent took the shared browser
pool's lock mid-run, the step's `eval` printed `pw busy … Try again`, and the script
continued to its final line and announced completion.

**A skipped step is a stop, not a silence.** The report shape that prevents it is a count —
steps run against steps in the script — rather than a trailing `done`, which describes only
that the interpreter reached the end of the file.

## Why this is not a testing-discipline note

**Skip does not read this code and cannot arbitrate a claim about it** — see
`AGENTS.md` §"He designs. He does not read the code either". Every measurement
reaches him through an agent, so a false finding is not a wasted hour of ours; it
is a wrong belief he has no way to check except by contradicting it from his own
screen, which costs him the thing agents exist to save.

**And a false finding does not sit still.** It becomes a task, a task becomes an
agent, and the agent is sent to repair a path that works — which is how a
measurement error turns into a regression.
