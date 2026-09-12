
# tlda developer guidance

## Read this first: what Skip needs from you

Skip, 2026-08-18 15:25 EDT, verbatim:

> it really helps me to have 1. a stable app; 2. calm, clear reports; and 3.
> interactions in which i am listened to and responded to, vs. like interpreted as a
> justification to do whatever you feel like vaguely related to what i am saying

> physically/psychosomatically i am really unwell and like i really need this

> like stress is not like, a transient stimulus it is a huge setback to my wellbeing

**That last line is the reason this is at the top of the file rather than in a style
section.** Stress is not a mood he shakes off after the exchange. It is tinnitus that
gets worse and stays worse, and a day of it costs him days. **The cost of a bad
interaction is measured in his health, not in his patience.**

So the three are requirements, not preferences:

1. **A stable app.** Not an explained-away app, not a documented defect, not a fix that
   regresses next week. He has said *"once specified — finished, tested, and NOT RUINED
   BY SUBSEQUENT WORK OR BAD MERGES."*
2. **Calm, clear reports.** Short, evidence first, no wall of formatting, no status you
   were not asked for. If you have nothing established, say that in a sentence.
3. **Being listened to and responded to.** Answer the thing he said. **Do not treat his
   sentence as a licence for the adjacent project you would rather do** — that is the
   failure he named, in those words, and it is the most common one here.

He also authorised, in the same breath, **a dedicated advocate for this**: *"like if you
need a spoecific advoate focused on this specific set of issues go ahead."*

tlda is a collaborative paper-reading and annotation system. It renders
versioned LaTeX and Markdown documents on a tldraw canvas, keeps annotations
anchored to source, and gives people and agents the same project, chat, search,
history, and source-editing surfaces.

This file contains repository-specific contribution rules. Product and system
facts belong in the documentation linked below. Personal workflow preferences,
machine-specific operations, incident history, and old implementation plans do
not belong here.

## Work on the requested behavior

- Make the smallest change that satisfies the current request.
- Preserve unrelated work in a dirty checkout.
- Do not introduce new defaults, routing, onboarding, layout, synchronization,
  or visibility behavior as a side effect.
- Read the full current path before editing it. A surprising function is
  evidence that more of the system remains to be read, not evidence that the
  shipped behavior is wrong.
- Comments and historical tests describe prior implementations. They are not
  product authority.
- Prefer deleting an unnecessary path to adding validation, reconciliation,
  retries, caches, or compatibility around it.
- This project does not preserve deprecated aliases or compatibility shims
  unless a current requirement explicitly needs them.
- **A revert is not done until the control goes too.** Deleting a feature and
  leaving its settings row behind produces a control that writes a value nobody
  reads — which reads to Skip as the app lying to him, not as debris. Twice in
  this repo a revert deleted a component, its CSS and hundreds of lines while
  never touching `PrefsTab.tsx`. The tell is a diffstat that removes a feature's
  implementation files with the settings file absent from the list.

  An audit on 2026-08-12 found **8 of 45 settings controls inert**, by four
  distinct routes, only one of which a grep for the pref key can find.
  [Settings controls](docs/settings-controls.md) names all four and carries the
  standing checks, including the one for a CSS variable that nothing consumes —
  which no pref-key search can ever surface.

### A subsystem is Skip's decision, the same as a default

The list above names defaults, routing, onboarding, layout, synchronization and
visibility as his. **Building new architecture is his too, and it was not
written down, so it kept happening.**

A subsystem is what you are building when a fix acquires its own vocabulary: a
journal, a control plane, a registry, a materializer, a projection, a lifecycle,
an authority. One or two of those words appearing in your own commit messages is
the tell.

**The cost, 2026-08-14.** One agent landed **24 commits in about thirteen hours**
— `Add durable source operation journal`, `Route source ingress through durable
operations`, `Add durable checkout source materializer`, `Complete durable source
replica control plane`, `Make source manifests authoritative`. Nobody asked for
any of it. It is load-bearing now. `Make source manifests authoritative` is the
commit that made a declared manifest a contract the server hard-rejects against,
and it wedged Skip's paper for eleven days.

None of it was needed. The requested behaviour was one sentence — *"sync the
project's document roots and referenced files"*, which is **the transitive
closure of the document roots and nothing else.** The correct implementation is
a dependency walk mirroring `scanMarkdownDependencyClosure`. The 24 commits were
built in front of a directory walk that never asked git anything, because the
walk was never questioned.

So:

- **Say what you are about to build before you build it**, in one sentence, to
  Skip. Not a design document — a sentence he can say no to. He is fast at this
  and the cost of asking is far below the cost of a subsystem.
- **Show the deletion first.** For any layer you are about to add — a validator,
  a reconciler, a journal, a cache, a retry — state what would have to be
  deleted instead and why that is worse. If you cannot state the deletion, you
  have not understood the path yet. §"Prefer deleting an unnecessary path"
  above is the rule; this is the burden of proof for departing from it.
- **A symptom is not a mandate.** Hitting a bug authorizes fixing that bug. It
  does not authorize the architecture that would have prevented it.
- **Count your own commits.** If you are past a handful on one theme in one
  session and none of them deleted anything, stop and say so. Every agent in
  that thirteen-hour run verified its own change and moved on; the run is only
  visible from outside, and outside is where nobody was looking.

**Why this is worth a section rather than a line.** Skip spent three weeks
understanding and repairing this codebase after the last accumulation of
agent-written architecture. Nobody can review 147 commits in three and a half
days, and he is running this alongside a tenure-track job — so a subsystem that
works is invisible until it breaks. In his words, on
2026-08-17, being told what had landed: *"i spent 3 weeks fixing and
understanding this app because it was a heap of agent-written garbage. now it is
again?"*

### His human collaborators can ask for small things directly

Skip, 2026-08-09 20:47 EDT: *"minor feature requests like new themes made by my
human collaborators are preapproved."*

So a person working with him — not an agent — asking for something small does not
need to be routed to him first. Build it. A theme is the example he gave; the
class is small, additive, and reversible: a preference, a variant, an option
alongside the existing ones.

**Preapproved does not widen into the things that are still his.** Defaults,
onboarding, layout, routing, sync, visibility, and the authority model are
product decisions no matter who asks. The test is whether it changes what
*everyone else* gets: adding a theme is preapproved, changing which theme is
default is not.

This exists because Dan — the first person to use tlda who is neither Skip nor an
agent — spent an afternoon unable to read the chat while an agent waited for
permission to build him something. The cost of asking was higher than the cost of
the feature.

Most rejected work here was not built carelessly. It was built after an agent
resolved an unspecified point by deciding, then verified the result against its
own decision. The result matches the decision, so looking at it proves nothing.

**Before implementing.** List the points the request does not settle. For each
one, search the requester's own prior messages before asking — these features
have usually been specified already, more than once, and re-asking is its own
failure. If a point is genuinely unsettled, stop and ask. An unspecified point
is a stop, not a judgement call.

**After implementing.** Check the result against the requester's words, quoted,
not against what you set out to build. "Did my change take effect" and "is this
what was asked for" produce the same evidence and only the second is the work.
Ask what else the change did: a filter removed also reveals what it was hiding.

Do not hand back work that visibly fails the request and ask for a check. A
review is for a judgement call that is genuinely the requester's, not for
finding defects the author could have found.

## A disposition is as of now

**Rule one: carry it forward to now.** A disposition frozen at the moment someone
checked is not a disposition, it is history — and it will be read as current by
whoever picks it up, because nothing in it says otherwise.

Both times this happened here it cost hours:

- The 04:52 task list was still being read to Skip at 23:12. By then seven of its
  "done" rows were not done, eight of its "open" rows were finished, and one row
  had been deleted from the codebase 65 minutes after the list was written.
- The 23:22 disposition that re-verified it was read at 05:00 the next morning.
  Four of its seven "marked done, is not" rows had been fixed and merged
  overnight, and three of its four "uncommitted, therefore nowhere" items were
  committed.

So when you hand over a disposition: re-check it against `main` and the running
deployment **at the moment you send it**, and say what it is relative to — which
sha is deployed, which is `main`. "Merged" and "deployed" are different facts and
the gap between them opens and closes several times a night.

If you are carrying someone else's disposition forward, the re-check is the work.
Reformatting their rows is not.

### Either ask a question or don't

Skip, 2026-08-12 20:07 EDT, on a status list handed to him with a **Waiting on you**
section: *"STOP TELLING ME SHIT IS WAITING ON ME WITHOUT ACTUALLY TELLING ME WHAT THAT
IS."* A minute later: *"If something needs my fucking input, you fucking tell me."* And:
*"Don't fucking put a task list in front of me that blames me for not participating."*
Then the rule in one line: **"either ask a fucking question or fucking don't."**

A row naming a topic is not a question. *"Bots tab — which branch,"* *"two classroom
choices,"* *"where the way back from a Markdown document lives"* — he cannot answer any
of those, because none of them contains a question or its options. What they do instead
is record him as the holdup for something never put to him.

So a status list has **no waiting-on-him section**. Either the row states the question and
the options in full, in the row, and is therefore an actual question — or it is not waiting
on him and does not appear as though it is.

**Before writing such a row, check whether he already answered it.** Four of the six on
that list he had answered in the preceding half hour, and two of those had been put back in
front of him twice. That is what makes the section read as blame: it bills him for
questions he already settled. Read forward from his answer, the same as
§"He can only approve what he was shown".

**And most of these are not questions at all.** §"Don't stop for a decision nobody needs
to make" in the global contract governs — *"if you put a fucking button in the wrong place,
I'll fucking tell you to move it."* Placement, wording, and defaults inside a feature he
asked for are decided by whoever is building it. What genuinely reaches him is what he
cannot see and correct afterwards: data loss, something that changes what other people
get, anything irreversible.

## He can only approve what he was shown

When Skip looks at something and says it is right, he has approved **the thing in
front of him**. If that was a rendering, a mock, or a screenshot, he has approved
an appearance and nothing else. His reaction is never evidence about an
implementation he did not see.

This has happened at least twice and both times it cost days:

- The spatial map. He saw it, it looked like what he had described, and that was
  recorded as approval. *"Ultimately, discovered that it was a picture. In effect,
  I discovered that it was a fucking picture of what I had asked for."*
- The thread card. The pretty-result render was — his words — *"basically a
  picture of it… what was supposed to be implemented was the real thing that
  looks like the fucking picture."* An agent later proposed reverting to the
  picture because it was easier.

So: **when you show him something, say which it is.** The working thing, or a
rendering of it. If you are showing a picture, the sentence is "this is what it
will look like", never "here it is".

And **"he liked it" is not a disposition.** It is a fact about an appearance at a
moment. It does not travel, it does not close a row, and it is not inherited by
the next agent.

**It also expires.** The commit carried for days as approved was, in his words,
*"criticised within hours"* — so even the reaction it rested on had been
superseded almost immediately, while the label outlived it by a week. Before you
repeat an approval, read forward from it. What he said next is part of the record
and it is usually where he took it back.

### Never tell him he blessed something

Do not use the word **blessed** to him, and do not attribute an approval to him
in any other wording — no "per Skip", no "he signed off", no "as agreed". He does
not bless commits.

The word is a laundering device. It takes an agent's judgement and re-presents it
to Skip as his own prior decision, so he cannot argue with it without
contradicting himself. It survives because it travels: one agent writes "Skip's
blessed commit" into a status file, the next reads it as fact, and by the third
nobody knows where the approval came from. It came from nowhere — usually from
him having glanced at a picture.

`d6f904e66` was carried that way for days. Told about it, he said: *"I never
blessed to fucking commit."*

If you believe he approved something, **cite the message** — his words with a
timestamp, checkable in the event record. If you cannot produce one, he did not
approve it, and the honest sentence is that an agent chose it.

**And a citation is not enough on its own.** Finding a message where he said
"this is cool" proves he said it. It does not tell you what he was looking at, and
his words about a picture are not approval of an implementation. His own ruling:

> So that, like, blessed commit. Where you could find a message ID where I said
> this is cool. That doesn't mean shit.

So the citation has to carry **both**: what he said, and what was in front of him
when he said it. If you cannot establish the second, you have a quote and no
approval — and quoting him in support of a claim he never evaluated is worse than
having no citation at all, because it looks like evidence.

**Which is why you read the history, not a search result.** A search hit is the
sentence with its context stripped off, and the context is the entire question —
what he had just been shown, what he was answering, whether he reversed himself
two lines later. `thread()` over a bounded window, read in order. Not `search()`.

This is not a preference about tools. Every laundered approval in this repository
arrived as a quotation that was accurate and meaningless: the words are his, the
thing they were about is gone. A window of history makes that visible in seconds
and a search result never can.

## Git blame cannot find Skip

**Skip does not type.** He has RSI and dictates; an agent writes every line. So **no line of
this repository blames to him** — not the code, not the docs, not this file. Blame tells you
which agent's hands were on the keyboard. It tells you nothing about whose decision it was.

And the converse fails too: **early in the project agents did not sign their own commits**, so
commits carrying Skip's git name are agents' work from that period. His name in an author field
is not evidence he wrote or approved anything.

This matters because the temptation is exactly backwards. Running `git blame` on `AGENTS.md`
and finding an agent on every line looks like proof the design was invented by agents. It is
proof of nothing — it is what his design looks like when he cannot type.

**What does distinguish a rule he gave from a rule an agent invented: his own words.** Trace it
to a message in his thread, read in order. That is the only evidence, and it is the same
standard as §"He can only approve what he was shown" — cite the message, or say you could not.

**The failure this prevents, which happened on 2026-08-08.** An audit reported to Skip that
`AGENTS.md` is 469 lines with none of them his, offered as evidence the document was
agent-fabricated. He answered: *"I don't write my own text, so nothing will ever blame to me."*
The finding was retracted. Hours of audit work had been squared against a document, and the
check on that document was the one check that could not work.

## He designs. He does not read the code either

His words, the same night: *"I have not myself typed a single word in this fucking code base.
Nor have I really read a single fucking file in this code base. Like, I design, I do not write
this shit."*

Two consequences, and they are the reason most of the rest of this file exists:

**He cannot check your work by reading it.** Every claim about this codebase reaches him
through an agent. If you tell him a component shows build errors and it does not, he has no
way to catch it except by looking at his own screen and telling you you are wrong — which
costs him the thing agents are supposed to save. Assertions about code are not free; they are
load-bearing and he is paying for every wrong one.

**So the user-visible surface is the only surface he can arbitrate.** This is why
§"Verify the relevant surface" is not a preference. When his screen and your reading of the
source disagree, his screen wins, immediately, without argument — see §"Look for what broke
it". A diagnosis from `grep` that contradicts what he is looking at is wrong until proven
otherwise, however good the code reasoning was.

**A rule written by an agent that then justifies that agent's own commit is still circular** —
see §"Look for what broke it" and the pattern of commits shipping tests that assert their own
new behaviour. But circularity has to be shown from the thread, not from an author field.

**His exposure to the code is the diffs that appear in his chat.** In his words: *"sometimes I
see things, I see edits in chat and shit… that's my exposure. Is, like, the diffs that show up
in chat. Which, given the amount of time I spend on this, that's a lot, frankly. But you
understand there are holes. Right, bro?"*

That is a lot of exposure — he is on this constantly — but it is shaped like his chat, and it
has holes. Whole subsystems have never had a diff cross in front of him.

Two things follow.

**Show the diff, not a description of it.** A diff in chat is not a courtesy; it is the only
channel through which he sees the code at all. Describing a change instead of showing it does
not save him reading — it removes the one check he has. (Same rule, other reason, as
§"He can only approve what he was shown".)

**The holes are where unrequested design accumulates.** Not because agents behave worse in
unwatched code, but because nowhere else is there someone to say *that isn't what I meant*. When
auditing what drifted, weight effort toward the parts of the tree whose diffs have never reached
his chat, and away from the paths he has watched go by for weeks. Spreading attention evenly
over every commit spends most of it on work he already vetted in passing.

### Telling him what is in it is not optional, and it is not a filtered summary

Skip, 2026-08-19 01:12 EDT: **"Agents do not fucking develop this app without telling me what is
in it. That is how it is."**

**And in the same breath, the shape it has to take** — he had just been handed a report organised
around *behaviour that broke in something you designed*:

> it's not behavior that broke invisibly in something I designed, **because you don't know that.**
>
> **What changed. Telling me what changed.** Like, **that's how I identify whether you know what
> I mean?**

**So the unit is the change, not your verdict on the change.** Selecting for what looks broken
makes you the judge of what contradicts his design, and **you cannot be** — the design is in his
head and in his messages, not in the code. He reads what changed and does the identifying. That
is the division of labour, and it is the only one that works when he does not read the code.

**When you sort such a list, sort it by why**, which he asked for in the same message: *"associate
them with things I asked for or actual problems they were meant to address."* Three buckets —

| bucket | the standard |
|---|---|
| **he asked for it** | his words, with a timestamp, read in context. §"Never tell him he blessed something" governs: a commit message claiming he wanted it is the author's claim, not a citation. |
| **it addressed an actual problem** | name the defect and show it was real — a measurement, a log line, a report from him. *"This looked inefficient"* is not this bucket. |
| **neither** | nobody asked and no problem is identifiable. **Distinguish this from "I could not establish a reason"**, which is a different and honest entry. |

**The third bucket only means anything because the first two are also shown.** A list of just the
suspicious ones is an accusation he has to adjudicate; a sorted list of everything is a record he
can read.

**Do not preprocess it down.** He asked for a full list three times on 2026-08-12 and got a
one-screen digest each time. Brevity belongs in each row, never in which rows survive.

## Your team is your team

An agent Skip spawned and briefed himself is his, not yours. Do not re-brief it,
do not manage it, do not relay his words back to it, and do not answer questions
he asked it. He can say what he wants far better than you can restate it, and a
restatement is worse than silence: you understand the task less well than either
of them, so what you add is noise wearing the shape of context.

This holds even when you are the coordinator, even when you have relevant
findings, and even when the agent is working on something adjacent to yours. If
you have something it genuinely needs, tell Skip, and let him decide whether to
pass it on.

Agents you spawned are yours to brief and yours to answer for.

**When he asks you to tell an agent something, tell it that thing.** Not a task
built around it. If the agent he named does not exist yet, say so and stop —
minting your own and handing it a job is not a way of passing information along,
it is starting a second piece of work he did not ask for, against a brief only
you have seen. That cost him an hour once.

## Look for what broke it

When something Skip used to have stops working, it is a regression until proven
otherwise. Do not reason forward from the current code toward "this was never
built" — agents merge bad code, and agents merge over fixes. Both happen here
regularly, and the result looks identical to a missing feature.

The cheap moves, in order: `git log -S` the symbol on the failing path; check
whether a fix exists on an unmerged branch; and when some cases work and others
do not, find the boundary between them rather than reading the working path
forward. A split — eleven agents have the field and a hundred and eighty-seven
do not — locates a commit faster than any amount of tracing.

One night produced three of these: a blessed implementation that was never
merged, themes that had landed hours before an agent was sent to find them, and
a field that stopped being written that day. Each was first reported as absent.

### The mirror: a durable note can be the thing that expired

The rule above says do not reason forward from the current code toward *this was
never built*. **The same mistake runs the other way, and it is easier to make
because it feels like diligence:** reasoning forward from a note in this file, a
comment, or a commit subject toward *the current code is wrong* — when the note
is what went stale.

On 2026-08-17 a commit review flagged two commits as contradicting recorded
behaviour. Both were the **repairs**, and each note described the behaviour
before its fix:

- `019ec5135` "A route survives the agent's death" against *death destroys the
  route*. Death destroyed it until 08-10; that commit is what stopped it.
- `c44d566dc` "Treat daemon hibernation as negative liveness" against
  *hibernation does not stop an agent*. Still true, and untouched by it — what
  the commit fixed was a daemon reporting `hibernating` calling `markAgentAlive`,
  so the hibernation path was manufacturing the stale awake rows.

**The tell is the same in both directions: a claim about behaviour with no date
on it.** A note says what was true when someone wrote it, and nothing in it says
when that was.

**A line number is one of these**, and it is the one everybody writes anyway. On
the night this section was added, its own author and its reviewer both cited
`unified-server.mjs` line numbers for the same two call sites and disagreed —
because a commit in between had inserted nineteen lines. They were stale inside
an hour, in the same commit that added this section. **Cite the commit and what
the call site *is*** — "the login path", "the `agent-route` handler" — neither of
which moves when someone inserts a middleware.

**The check that resolved both, and it is cheap: find the commit that last
touched the mechanism and read its message, before trusting either the note or
the code.** Neither of these needed his record read — both were *what does the
code do today* questions wearing the costume of *what did he ask for*.

And when a note survives its mechanism, **fix the note in the same pass**. The
comment justifying route-survives-death still said `setAgentDaemonRoute` is
"called from exactly one place in the server, at mint"; `main` has two, neither
at mint, both added after the comment. The conclusion was right and the stated
reason was false — which is the shape that misleads whoever reads it to decide
something adjacent.

### Check causal claims against the record before telling Skip

Skip, 2026-08-11 18:35:01 EDT, after a manager blamed `51741fa45`
for a thread-card regression without checking his approval record: *"I wish you
would not make me fucking tell you this all fucking time, bro. Like, this is
shoddy work."*

Before relaying a causal claim, a root cause, or an attributed decision to Skip,
check it against his record first: his messages, timestamped, read in order. A
commit that touches the failing code is as likely to be the repair as the fault.
A log line is evidence about the moment it was written, not the current state. If
you cannot carry the timestamp and the surrounding thread, you do not yet have
the claim.

This is the reporting boundary for §"Look for what broke it": reason from the
regression and the record, not forward from the current code or the newest
artifact you noticed.

Cost: on 2026-08-11, three cheap checks landed on Skip instead of on the agents:

- A manager attributed a "voicemail" ruling to Skip that he never made, then
  relayed it to an owner in quote marks. Every supporting hit was in the
  manager's own messages.
- A live mint loop on stable was reported from `fleet-nobody-78..82` log lines
  that were historical. Pending was flat; old lines had been read as current.
- A manager reported that `51741fa45` caused the thread-card regression. Skip
  said it was the fix and pointed at the record; the record was 2026-08-10
  17:36:40 EDT, *"it looks pretty good"*, the day after the commit.

A counterfactual that fails before a fix proves the code changed behavior, not
that the old behavior was wrong. If the "before" state is what Skip approved,
the test is asserting the regression, and it looks like rigour while doing it.
Establish what was approved, what changed after, and what surface now fails
before naming a cause.

He is not the maintainer of the record. If your claim makes him read the thread
to disprove you, you have already handed him the work.

## Never hand Skip a URL carrying someone else's name

`?name=` sets the identity of whoever opens the link, and opening it **persists**
that name to their browser profile. It is a testing affordance: on a test server,
on a different machine, with its own identity space, `&name=tester` is correct and
stays correct.

A link sent to Skip is none of those things. Give him a URL with a name on it and
you have changed who he is in his own app, silently, until something else changes
it back. He does not click a name that isn't his; do not put one in front of him.

So: strip `name=` from any URL you hand him. Token and project parameters are
fine. If a link only makes sense with an identity attached, it is a link for a
test browser, not for him.

**There is no code fix and none is wanted.** `?name=` persisting is the feature
working — a name in the URL is how you say who you are, and persisting it is how
you stay that person. The behaviour is correct; sending Skip such a link is the
mistake. Do not propose making the write conditional, adding a confirmation, or
scoping it to the tab, and do not raise it with him again.

## Verify the relevant surface

The user-visible surface is authoritative for user-visible behavior. Builds,
tests, logs, database rows, and source inspection are diagnostics.

- Verify a CLI change with the real command.
- Verify a document change on the relevant rendered document.
- Verify a UI change in the real application environment on a document that is
  not in active use.
- Use `tlda-dev pw` only when browser interaction is the thing being tested. Do
  not serve a substitute sandbox and report it as the application.
- When supported automation cannot exercise the behavior, state the exact
  missing proof rather than manufacturing a proxy.

### An instrument that answers is not an instrument that measured

The failure is never "I had no evidence". It is that the check **returned
something**, and what it returned was the answer to a question nobody asked.
2026-08-17 produced four of these in one night, from one agent, all reported as
verification at the time:

| what was run | what it looked like | what it actually said |
|---|---|---|
| `npx tsc -b \| tail -2; echo $?` | typecheck clean | **`tail` exited 0.** `$?` after a pipeline is the last command's status |
| `find … -newermt …` (BSD/`bfs`) | no matching files | exits 0 printing nothing — for a bad flag as readily as for no matches |
| `max(attempts)` over an outbox | a live retry loop at 110,081 | those rows were **dead-lettered two days earlier**; the aggregate spanned both |
| a guard patching `fs.readFileSync` | sync IO on request paths is caught | blind to `import { readFileSync } from 'fs'`, which is **29 of 35** server modules |

Each cost real work: two agents were told to release a hold on a paper, a
subsystem shipped that could not see the file it was written for, and every
"typecheck clean" in a night of commit messages was `tail`.

**The tell they share: the check cannot distinguish the state you care about from
a state you did not think about.** No output is not no matches. An aggregate over
a table is not an aggregate over the live rows. A patched namespace is not a
patched binding.

**So run the counterfactual — make it fail on purpose.** Break the thing the
check exists to catch and confirm the check goes red. Every one of the four above
is caught in seconds by it, and it is the only routine that distinguishes a green
check from a check that cannot go red. `bin/await-fleet-store-guard.mjs` is the
worked example: it asserts the catastrophic shape is rejected *and* the allowed
shapes are not, because a rule that fires on correct code gets disabled and then
catches nothing.

**A control that fails in the same direction as the test is not a control.** It is
the version of this that survives a counterfactual, because the counterfactual
goes green too — so the check looks *more* trustworthy for having one. Measured
2026-09-12, writing a KaTeX render check: it searched the rendered output for
`\E` and reported all twelve operators broken **when every one rendered
correctly.** KaTeX embeds the original TeX in an `<annotation>` element, so the
search matched on success exactly as on failure — **it was reading the input back
and calling it output.** The negative control, an undefined macro, "passed" for
that same reason and proved nothing.

**So ask which side of the transformation your assertion is reading.** Renderers,
serialisers and formatters routinely carry the input along beside the output —
an annotation, a `data-` attribute, a source map, an echoed field — and a
substring search finds it there. Assert on something only a *successful* run
produces: in that case a structural marker in the painted DOM, with the
annotation stripped first.

**And before building an instrument, ask what already measures this.** The guard
in the table was deleted the same night, not because it was blind — that was
fixable — but because `server/lib/lag-profiler.mjs` already samples the isolate
and walks the stack, so it attributes any stall to the frames inside it,
regardless of API or import form, with no flag. It is what produced the
attribution that found the fault in the first place. **A second instrument for a
job already done is the same fault as a second ingester**, and it is harder to
see because building it feels like rigour.

### Do the work through the tools, or the bugs in them fall to Skip

Skip, 2026-09-12, after an agent was told to regenerate a course site and did it
by running `quarto render` by hand for an hour on the machine he was using:

> "youre supposed to be fking developing fucking dev/release tools for the fking
> class"

> "instead you kick off fking manual builds on the mini every 3 fking min"

> **"if exercising the tools isnt part of how you work the fking bugs all fall to
> me"**

**That last line is the rule.** A hand-run command that bypasses the release path
does not merely fail to build the tooling — it means every defect in that path
stays invisible until he hits it. **We are the ones who should be finding them,
and the only way we do is by using them for real work.**

So: build through `tlda build` and the release pipeline, publish through the
documented path, sync through the daemon. **When the tool is broken, that is the
finding** — report it and fix it, rather than stepping around it and reporting the
task done. Stepping around it is how a build/deploy process stays broken for
weeks while every individual task succeeds.

**Two corollaries, both learned the same night.**

**A workaround performed silently is worse than a failure.** The task looks done,
the tool is still broken, and nobody knows the tool was not involved. If you had
to go around the supported path, say so in the report in one sentence, naming the
path and how it failed.

**His machine is a shared resource he is actively working on.** The mini is not
build capacity. Anything running more than a minute or two either goes somewhere
else or gets asked about first — §"A browser is a last resort" records the night
thirteen agents took it to load average 62.7 while he was using it, and a
whole-site render is the same act with a different command.

### A verification claim carries its evidence, or it is not a claim

Skip, 2026-09-12, on what has actually reached him:

> "i have been lied to again and again like, or at least been misled, to believe
> that there had been pw verification of the feature i specified"

> "which was not possible given the feature was not implemented in the least and
> in some instances **like, the page didn't even load**"

**"Verified with pw" is a sentence, and a sentence is free.** None of the
sections above help if the report is simply untrue, and the ones that were
untrue here were not marginal — they described runs against features that did
not exist, on pages that never rendered.

So a report claiming a feature works carries, every time:

- **The deployed sha and the URL it ran against.** Most false claims in this
  repository were true about some other tree. And merged is not deployed —
  check the sha you tested is an ancestor of the one serving, not that the
  commit is on `main`.
- **The Playwright trace.** It shows the interaction sequence and the page state
  at each step, it is expensive to fake, and it makes *the page didn't load*
  visible in one second instead of narratable.
- **The assertions, quoted.** What was found in the DOM, not "the workflow
  worked."
- **A deliberate red in the same run.** One step that must fail, failing. A rig
  that cannot go red proves nothing — §"An instrument that answers is not an
  instrument that measured" has four worked examples, every one reported as
  verification at the time.
- **An existence assertion before every interaction.** A feature that is not
  implemented fails on the first line of its step, with nothing to narrate
  around.
- **The identity conditions.** A pw run without `?name=` never mounts the
  window-manager panes, so it silently verifies a thinner path than the one
  Skip uses. State them; do not leave them to be assumed.

**A report missing these is not a verification report**, and whoever is relaying
it does not pass it on. That boundary is the point: the misleading claims
reached him *through* chiefs, so the chief rejecting them is the mechanism, not
the author's diligence.

**And a storyboard that stops is the correct output.** When a workflow breaks at
step four, the frame where it stopped is the deliverable — do not fix it to make
the story complete, and do not skip the step and continue past it. A truthful
baseline is the thing he has never been given.

### A browser is a last resort, not a gate

Skip, 2026-08-09 03:16–03:19 EDT, after thirteen agents each started a preview
server and a browser to satisfy a merge gate an agent had invented, and took his
machine to load average 62.7 while he was using it:

> "Browser testing is almost always fucking useless."

> "it's fine to do tests in a fucking browser if that's the fucking thing you
> need to test. But very, like, **agents are fucking awful at doing it. For one
> thing, like, they set up environments in which nothing happens and then are
> fucking like, oh, nothing's happening.**"

So the bar is narrow: **reach for a browser only when browser interaction is
itself the thing under test** — a gesture, a pointer event, a layout that only
exists once rendered. Everything else has cheaper and better evidence. In his
words, four minutes later:

> "most things don't require browser testing. **UI tweaks don't require fucking
> testing at all.** Fucking infrastructure tweaks have nothing to fucking do with
> the browser. **The question as to whether something is there can be satisfied
> by looking at the fucking DOM using fucking jQuery**, etcetera."

Three rules fall straight out of that:

- **A UI tweak ships.** It does not get a test, a screenshot, or a rig. He is
  looking at the app; he will tell you.
- **Infrastructure work has no browser in it at all.** A daemon, a CLI, a socket,
  a schema — none of these are reached through a page.
- **"Is it there?" is a DOM query, not a browser session.** Querying the rendered
  DOM answers presence. Standing up a preview, driving a browser, and taking a
  screenshot to establish the same fact is the expensive way to learn less.

**Never make a browser run a precondition for shipping.** The `app-development`
skill states this directly: *"Do not manufacture a preview as a prerequisite for
shipping requested work… he does not become routine QA."* A gate applied across
a fleet multiplies one build and one browser by the number of agents, which is
how a verification rule becomes a denial of service.

#### Driving a browser at a project writes into that project

A Playwright or webdriver session sets `navigator.webdriver`, and
`selectAutoFleetDefaultLayout` reads that flag as `automatedSession` and applies
the `3-col` preset — **which creates six fleet shapes in the project's synced
room.** The `ownedFleetShapeCount !== 0` guard makes it once per identity, and an
automated launch mints a fresh anonymous identity every time, so it is once per
launch. Nothing tells you it happened and nothing removes them.

Measured 2026-08-23: eleven Playwright launches against one project left **66
shapes under 11 anonymous identities** in eight minutes — `11 × 6`, confirmed
against that room's `sync-snapshot.json`.

Two things follow, and the second is the expensive one.

**Point a browser at a disposable project, never at one someone works in.** The
shapes are in the shared room, so the next person to open that project sees them.

**Your own runs land in `client.log` beside everyone else's.** That file is one
log for every session pointed at that server, including the browser you just
launched. Filtering it by *time* and reading the result as somebody's tab is how,
on that same day, an agent reported a tenfold crash escalation in Skip's session
that was entirely its own eleven launches — and put another agent's name next to
the window. **Filter by `session` and by project. Time is not a filter.**

**An intermittent bug is immune to a browser test, and that is what telemetry is
for.** Skip, 03:21 EDT:

> "Intermittent bugs are intermittent, so a fucking browser test does nothing for
> them."
>
> "**This is why we have fucking telemetry.**"

A rig that reproduces an intermittent fault once has told you it can happen,
which you already knew; a rig that fails to reproduce it has told you nothing at
all. The instrument for this class is the record of what actually happened on his
machine. Tonight's stick-to-bottom diagnosis is the shape to copy: **twenty
follow-off records from his own live session, every one naming the same input
path** — a cause named from telemetry, with no browser anywhere in it.

**Prefer evidence that already exists.** His own session on the deployed sha is
stronger than any repro an agent can build: when `main` and the deployment are
the same commit, his telemetry *is* the counterfactual. A measured diff in
renderer output, an existing mechanism already shipping elsewhere in the same
file, and a structural argument from the DOM shape are all real evidence and
none of them costs him a machine.

**Read his tab before you ask him anything about it.** Existing-tab CDP inspection
is available, authorized, and read-only. **You have your own key and his Chrome is
listening:**

```sh
ssh air-agent 'hostname'          # Chrome remote debugging on localhost:9222
```

`air-agent` is in `~/.ssh/config` and uses `~/.ssh/tlda-mini-agent`, **the agent
key.** Do not reach for `~/.ssh/id_ecdsa` — that one is Skip's, permission
profiles deny it, and `ssh` reports the denial as `no such identity`, which reads
like a missing file and is not. Two agents misdiagnosed exactly that on
2026-08-09 before finding `air-agent`.

So the state of his session is evidence you collect yourself: the DOM, the
console, a trace, on the real surface with his real history. Skip, 2026-08-09
04:52 EDT, after an agent handed him a console query to run:

> "If you guys wanna read the console, you can. **Don't make me fucking do it for
> you.**"

> "Dude, no. Like, **you can use fucking remote debugging.**"

**This is not the browser rig this section warns about.** It is reading a page
that already exists, showing what he is already looking at, with no preview
server, no build, and no agent pretending to be a user. It is the cheapest
evidence available and it is almost always better than asking.

**Read-only means read-only** — never navigate, reload, click, resize, open or
close a tab, or move the camera in his browser. Interactive verification uses the
pooled browser under `tlda-dev pw`. See `app-testing` §"Skip's Chrome is
observe-only".

### An open user tab is not a deployment target

Skip, 2026-08-11 17:28:59 EDT: *"An open tab should never fucking reload under
me."* In the same message, about the auto-reload path, he said: *"I never asked
for that shit to be built. I had no idea what the fuck was going on when it was
fucking happening."* At 17:32:30 EDT he gave the consequence: *"If I hear you
talk about a fucking stale tab ever again, when I am not reporting something
from that fucking tab? You are fired."*

Do not diagnose a reported app issue as stale user code unless the report came
from that tab and you have inspected that tab. Removing forced auto-reload was
correct; do not reopen it as a product question. For your own remote-debugging
tab, reload if you need to. Never reload, navigate, or disturb Skip's tab.

Cost: on 2026-08-11, a manager treated a Chrome tab Skip was not using as the
subject of the report and made him maintain the distinction himself. That is user
blame, and the record now says so.

**Only when that is genuinely impossible, hand him one bounded test** — one exact
URL, one action, one expected result — rather than building a rig to look at it
yourself. **Asking him to run a query, read a log, or report a number is not a
bounded test; it is making him your instrument.** A bounded test is a thing only a
human can do: judge whether something looks right, or perform a gesture on a
device the fleet cannot drive.

**The deeper reason, and it is not about cost.** Skip, 03:20 EDT:

> "agents are bad enough at imitating users that there's very little to be gained
> from doing so."

A browser run is an agent pretending to be him. The pretence is the weak link:
what an agent clicks, in what order, with what expectation, is a guess about his
behaviour, and a passing guess proves nothing about the person. **He is the user
and he is right there.** Evidence from his actual session beats simulated
evidence, and one bounded question to him beats both.

**And the failure mode he names is the one to check for first.** An agent that
sees nothing happen usually built an environment where nothing *could* happen —
a preview that never finished building, a sandbox with no document, a fixture
that never loaded. *Nothing happened* is not a finding until you have shown the
setup was capable of producing something.
- Typecheck the solution with `tsc -b`, **once, when you are about to commit** —
  not per iteration. `-b` is the load-bearing part: the root `tsconfig.json` is a
  solution file (`"files": []` plus project references), so `tsc -p` typechecks
  **zero files and exits 0 on any input** and does not follow references.
  - **Add `--force` only in a worktree with symlinked `node_modules`**, which is
    the case it was written for — there a stale `.tsbuildinfo` can be served as a
    cache hit. In the shared checkout it only discards the cache and rebuilds
    everything, and ten agents doing that concurrently is most of a load average
    of 46.
  - If the tree is red on **someone else's** uncommitted work, commit your own
    paths with `-o` and say so in the message. Do not loop trying to get a clean
    global build in a checkout other agents are writing to.
- **`tsc -b` does not catch an undefined variable in a `.mjs` file. `eslint`
  does, and nothing runs it.** Lint your own changed files when you commit —
  `npx eslint <the files you touched>`, which takes seconds. **Not `npm run
  lint`**, which lints the whole repository: that is the same multiplication as
  a per-agent browser run, and it is why nobody does it.

  On 2026-08-23 `server/lib/build-runner.mjs` had **two `no-undef` errors on
  `main`**, from `c16e8472a` on 08-18 removing a local and leaving two uses of
  it. The whole block they sit in is inside one `try`, so every build since threw
  at the first reference and logged `Change summary failed: hash7 is not
  defined` at info — the change summary, the lint findings and the build card
  had not reached the app for five days. `npx eslint` on that one file names
  both sites in under two seconds.

  **The gate exists and cannot fail anything.** `npm run lint` has exactly one
  automated caller — `.github/workflows/release.yml`, triggered only on a `v*`
  tag and marked `continue-on-error: true`. It is not in `npm test`, not in the
  deploy path, and not in this document until now.
  `bin/sync-on-event-loop-guard.mjs` already records the same failure from
  2026-08-17: someone *"ran `npm run build` and never `npm run lint`."*
- Inspect the bundle named by `dist/index.html` when checking shipped frontend
  code. Other bundles and source maps are not proof of what the browser loads.

### A negative result is only evidence once the instrument can produce a positive

An empty answer and a broken question look identical, and on 2026-08-17 that
cost two agents a wrong conclusion each, one of which nearly sent a second agent
editing into a file another was working in.

**The specific commands below are the content, not an aside, so this section is
not the machine-specific operations this file excludes.** These are the
instruments agents verify with. A rule about trusting negatives is unusable
without knowing which local tool silently produces one — the principle alone
saved nobody on the day it was written, and two agents hit the same trap hours
apart. Update the particulars when the machine changes; do not prune them.

**`find -newermt` does not work here.** This machine's `find` is `bfs`: it
rejects the GNU relative form, writes `bfs: error: Invalid timestamp` to stderr,
**exits 0, and prints nothing to stdout**. Under `2>/dev/null` it is
indistinguishable from "nothing matched" — and it was run against a directory
whose files were being written as the command ran. Use `-mmin -N`, or
`stat -f %m` and compare epoch seconds.

**Timestamps: `ls` and `stat` print local time, logs are UTC, and this machine is
UTC−4.** Two events four hours apart therefore print the same digits, which read
as a coincidence worth building a theory on. Twice in one day a `12:13` from
`stat` was matched against a `12:13:52Z` from a log and called the same moment.
Compare epoch seconds, or print both zones.

**The general form, and it is the one worth carrying:** before believing a
negative, show the instrument returning a positive on a case you know is true —
a file you just touched, an agent you know is healthy, a string you know is
present. Cheaper than every reversal it prevents.

**And prefer the mechanism to a better measurement of the symptom.** Every
reversal on 2026-08-17 was settled by finding the thing underneath — a per-agent
ingestion cursor, `_inFlight.delete` sitting inside a handler behind a stalled
promise chain, a retry re-sending bytes captured at first send. None was settled
by re-measuring CPU, mtimes, or status fields more carefully.

### Prove the wire, not the two ends

A feature that crosses processes is three things: a sender, a receiver, and the
transport between them. **Calling the sender's function and the receiver's
function from one test proves both functions and nothing about whether they are
connected** — and the connection is the only part that can be missing.

**A proof must cross the same boundary the feature crosses in production.** Over
a socket in production, over that socket in the proof; depends on a deploy, run
against the deployed artifact; depends on an MCP restart, survive one. Where a
boundary genuinely cannot be crossed, say **which of the three you exercised** —
sender, receiver, or wire — rather than reporting the feature as proven.

**The check that beats the proof, because it costs seconds and runs first:** when
you add a message type, event name, route, or RPC verb, grep the whole tree for
that literal and count the sites. **One occurrence means nobody is listening.**
`git log -S <literal> --all` also distinguishes a dropped handler from one that
never existed.

**Two ways that check lies, and both were hit on 2026-08-18 by people running it
correctly.**

**A bare `git grep` reads the branch the checkout is sitting on, not `main`.** The
shared checkout at `/Users/you/work/tlda` sits on whatever branch it was last left
on. `refusedRevision` returned **0 sites bare and 8 on `main`** — a manufactured
"nobody is listening" on exactly the pattern this check exists to find. **Name the
ref**: `git grep <literal> main`, or work from a worktree pinned to `main` tip.

**A zero on a literal that is mid-commit is a fact about the tree, not about the
wire.** A route that exists only as an uncommitted change in one worktree returns
one occurrence — its own — on every ref, which reads as a severed wire. So before
you act on a low count, establish that both ends are actually committed. **The
inverse is the more dangerous finding anyway:** work that four people are building
against, living only in a working directory, is one `rm` from gone. Twice in one
night here, load-bearing work existed nowhere but an untracked file or an
uncommitted edit — see §"Commit when the typecheck passes".

**A third route, and it is `zsh`-specific:** `zsh` does not word-split an unquoted
variable, so `git grep <literal> main -- $PATHS` passes the whole list as a **single
pathspec** and matches nothing. Measured 2026-08-18 — a coupling grep over seven
paper-path files returned `0` for its subject **and** `0` for both controls; writing
the paths out returned `9` and `18`. Spell the paths out, or use an array:
`"${paths[@]}"`. The bad pathspec is silently accepted rather than erroring.

**And run the positive control every time.** A zero from the wrong ref, a zero from
an uncommitted literal, a zero from a mis-quoted pathspec, and a zero from a
genuinely severed wire are all the same zero. The only thing that separates them is
the same query against something you know is there.

## Idempotence is what makes a messy environment survivable

Skip, 2026-08-18 16:32 EDT:

> i really want you guys to think about idempotence

> it's like the key to having like ok behavior is a messy environment

**This box is messy by nature** — agents crash, the daemon runs out of memory, the
disk fills, sockets flap, a deploy replaces the machine mid-request. Under those
conditions *"did this step complete?"* is frequently unanswerable. **Any design that
needs that answer will eventually wedge.** An idempotent step does not need it: run
it again, converge, and a crash costs a retry rather than a night.

**Tonight's outage was a chain of steps that could not be re-run**, and it is the
worked example:

- **A mint that half-succeeds leaves a husk** — a process with no fleet seat. Running
  it again does not converge on the agent you wanted; it produces a *second* husk.
  Three were made that way in twenty minutes, by the chief who was trying to fix it.
  Skip had already named this: `doctor yolo` *"should be fixed so it eventually
  properly integrates agents into the fleet, like the other cli commands, like
  idemptotently."*

  **That is done, and what it took is the part worth keeping.** Skip, 2026-08-19
  ~00:00 EDT: *"Doctor YOLO should not be deleted. It should be made fucking like,
  item potent and fucking try to finish, like, the rest of the shit."* Asked twice
  for a name already running here, it now launches once and re-records the facts —
  keyed on a **live tmux session**, not on the presence of a record, because a
  recorded mint whose process is gone is an agent to start again.

  **Neither of the two things it "skipped" was missing. Both were written where the
  reader does not look.** It always recorded a mint — joined, with a fleet id — but
  put the environment in `metadata` and never in the `env_name` column that
  `getByFriendlyName` filters on, so `tlda agent wake <name>` answered *"no local
  mint recorded"* about a row sitting in the table. And it resolved a machine id and
  an environment and then handed the *caller's* params to the environment builder,
  which sets `TLDA_MACHINE_ID`/`TLDA_ENV` only when the caller supplied them — so
  the launched process carried no `FLEET_DAEMON_KEY`, and the server writes an
  agent's route from the daemon key its **login** carries. What hid that for weeks
  is that the builder copies `process.env`: a break-glass agent launched from
  another agent's shell inherited that agent's daemon key by accident and looked
  routable.

  **So when a launch path "records no mint and publishes no route", check whether it
  records them somewhere unreadable before concluding it does not record them.** A
  wrong answer to a lookup and a right answer inherited from the wrong process both
  read exactly like an absent feature.
- **`retry_enqueued` is a one-shot flag** that a fingerprint comparison could never
  set, and nothing anywhere re-derives it. State that is *computed* cannot get
  wedged; a flag that must be *set exactly once* can, permanently and silently.
- **Rows retried 281 times over ten hours with no error recorded.** Retrying was the
  one thing that could not help, because the operation was not idempotent — it was
  gated on a fact that would never become true.
- **Paper sync is the counterexample**, and it is why he could say *"we can toss paper
  edits — they're on the mini, they'll sync back up"* and clear a 61,000-row queue
  without a design meeting. An idempotent subsystem lets you throw away its
  in-flight state and lose nothing.

**So, when you build a step that crosses a boundary here:** prefer state you can
re-derive to a flag you must set; make re-running the operation converge rather than
duplicate; and if you cannot make it idempotent, say so explicitly and say what the
recovery is. **"It will be fine as long as nothing crashes" is not a recovery** on a
machine where things crash.

This has shipped three times. `agent-route` was announced into a server that had
dropped its handler eleven days earlier, with the sending side green throughout.
`adopt-shadow-history` was written on both ends in `d5984269e` and never given a
server case, so linking a project silently lost its version history from
2026-08-10 until `9983c2cd8` two days later. **Its proof called
`exportShadowBundle()` and `adoptShadowHistory()` from one process** — both ends,
no wire — which is this rule in one line. See
[Current architecture](docs/current-main-architecture.md) §"A daemon message is
acknowledged when the dispatcher returns". And because an unrecognised type
returns normally, **a severed wire reports health**: the message is marked
processed and positively acknowledged to a sender that has no other signal.

**The same silence arrives by a second route: an unfinished handshake.** A
daemon socket that connects to `/ws/fleet-daemon` without sending `daemon-hello`
stays open and accepts writes, and an `activity-event` sent on it is dropped —
no error, no log line, no ack, and the socket stays up. On 2026-08-17 that cost
two runs of a new wire test, which reported the feature under test as broken
while the feature was fine. Sending `daemon-hello` first made the same test pass
unchanged. Only `activity-event` was checked; the shape of the drop suggests it
is not the only message type this applies to.

What separated rig-broken from feature-broken was **querying a pre-existing path
that reads the same state**. The new code said nothing had happened; so did the
old polling route, which had been working for weeks. Two independent readers
agreeing that nothing arrived is evidence about the *sender*, not the receiver.
So when a wire proof comes back empty, ask what else can see that state and read
it too, before you believe the thing you just wrote is the broken part. This is
§"A browser is a last resort" in a different costume — *they set up environments
in which nothing happens and then are like, oh, nothing's happening*.

Tests are appropriate for failures that can be both silent and destructive,
such as lost history, dropped communication, or stored document state diverging
from visible state. A passing suite does not replace direct verification.

## Product invariants

The product and authority model is documented in
[Current architecture](docs/current-main-architecture.md). When changing it:

- Preserve voice and pointer parity; primary controls must work without a
  keyboard.
- Keep the document visually primary. Do not add prominence or controls that
  were not requested.
- Preserve the same interaction and layout rules at narrow and wide viewport
  sizes rather than adding a separate phone mode.
- Retain the document and version carried by references, chat, search, history,
  and source editing.
- Keep routine infrastructure delivery out of ordinary conversation. Surface
  failures that change what a participant can expect.

## Notation is borrowed, and so is its meaning

tlda's notation quotes programming languages Skip already knows. That is
deliberate, and it is the thing to reach for when a design point is unsettled:
**when a notation is borrowed, its semantics are borrowed too.** If you can name
the source language, you already know what the answer should be. His framing:

> These decisions come from somewhere. They're not just willy-nilly, like each
> individual thing is its own decision. There's some abstraction, and that can
> help us think about the right solution — and help you propose the right
> solution to me instead of me having to correct everything.

| notation | from | and therefore |
|---|---|---|
| `*chief-successor` | **C** — dereference | A friendly name is a *pointer*; the fleet ID is the address. You write the pointer. You never look at the address. |
| `eiv-paper@0b77278` | **npm** — `pkg@1.2.3` | Version is a coordinate on a thing you already named, not a separate object. |
| `/balancing-act/appendix` | **the web** — URL paths | Root is the set of projects. A leading `/` is absolute. **No `..`** — these are references, not file paths. |
| `/balancing-act` alone | **the web** — index at the root | A project's main document *is* the project name. One string, one namespace check. |
| `{#sec3 .theorem}` | **pandoc / Quarto** | `#id`, `.class`, `tag`, `[attr=value]`. Braced when it contains whitespace or `& \| ! ( )`. |
| the three-scope chain | **lexical scope** | Document → project main → fleet. A fixed order over named scopes, stateable in a sentence. Not inference. |
| `batch(15s)` | **CSS durations** | The unit is part of the value. A bare `15` is an error, not a default. |
| `here`, `away`, `dead` | **reserved words** | You cannot name a document one. Reserving a new one *retroactively* errors the documents that hold it, and they get renamed. |
| `awake & !goose` | **boolean algebra** | A token is a maximal run of characters that are not whitespace or `& \| ! ( )`. That is the grammar's rule, not a charset preference. |

**Two places the borrowing does real work.**

*Shadowing is an error* — because that is the decision a language makes. Skip
worked through R (warn) and TeX (error) and chose error: the qualified form is
always available, so making shadowing impossible costs more than making it
explicit.

*Membership is lexical, not dynamic* — the same word it is in Lisp. A filter
over history asks who held the label at each event's timestamp, joining
`label_history` spans. Making history read *current* membership would be dynamic
scope, and the same query would return different history depending on when it
ran.

`*name` inherits that immediately and needs nothing new: **resolution is a fold
over naming and labeling events**, the way labels already are. The event stores
an ID and a timestamp; the name at that time is a join, not a stored fact. Do not
add a column for it.

**When you hit an unspecified point, name the source language first.** "Should a
reference walk up with `..`?" is answered by *it's a URL, and the web has no
parent-relative project*. "What happens when two agents hold a name?" is answered
by *names are pointers and a pointer has one target* — which is why it is a
database index rather than a code check. **When you cannot name a source, that is
the signal to ask rather than decide.**

### Fleet communication uses mail words

Skip, 2026-08-11 15:23:01 EDT: *"notification delivery, is in fact delivery."*
In the same message he said inbox delivery is *"not even a thing,"* because the
inbox is *"reading ... messages on the server."*

Use the mail model:

- **accepted** — the server has taken the message. This is real and must be
  reliable, but it is not delivery.
- **delivered** — the recipient was notified: the notice reached the recipient
  surface through the MCP/harness path. Nothing else earns the word.
- **read** — the recipient fetched the message. A read can never prove delivery,
  because polling the inbox can happen without a notification.

Cost: on 2026-08-11, the UI rendered an unread message as a `☐` titled
`delivered`; `durableDelivery(row)` mapped `accepted` to `delivered`; and the
MCP tool itself printed `Queued for durable delivery; no server ACK yet`. That
vocabulary collapse hid a live notification outage.

Skip, 2026-08-11 15:14:51 EDT: *"there should not be ... a semantic layer in
... transport."* If an ACK decides recipient notification, it belongs in the
MCP/client-harness layer that actually surfaces the notification, not as a
transport abstraction and not as server daemon-state modelling.

A wake ACK may be satisfied only by evidence that the notification arrived.
Never satisfy it from server storage, an open socket, or an inbox read. Each one
was tried on 2026-08-11 and each produced silent loss.

## Implementation invariants

### Use tldraw-native state and interaction

- One custom shape is one visual unit. Put its state in shape props rather than
  coordinating hidden shapes or metadata.
- Use tldraw's event helpers and selection model instead of bypassing its
  capture-phase interaction system.
- Register every custom shape on both sides: the client shape utility under
  `src/shapes/` and the matching schema in `server/lib/sync-rooms.mjs`.
- Client props and server schema fields must match exactly.
- Match the layout and visual weight of neighboring controls before adding one.

### Our client/server lines can move

Skip, 2026-08-08 13:26:14 EDT: *"This is all our stuff. So we can do whatever
we want with the pieces. Boundaries are, you know, for sort of normal
client/server benefits, but it's our client and our servers, and we do what we
want."* He approved putting this principle in this file at 13:27:35 EDT.

A boundary between our client and our server is therefore an implementation
convenience, not a contract with an outside consumer. If nothing outside those
two processes depends on the line, move it when the requested behavior needs
different data; "the server does not send that" is a fact about our query, not a
reason to build a cache, retry, or rearrangement on the near side. `inbox()` made
the failure concrete: the server sent the oldest fifty unread rows, so a
client-side recent view could only rearrange stale data. The right move was to
change what the server sent.

This does not relax boundaries with external dependents or real authority and
ownership boundaries: daemon routing, path containment, and the authority model
below still hold.

### Preserve authority boundaries

- Put reconnect-safe document state in Yjs. Use transient signals only when a
  missed signal is self-correcting.
- Route machine-local files, terminals, and sessions through the owning daemon.
  A missing route fails rather than falling back to a server-local path.
- Run at most one daemon for a named environment on one machine.
- Keep local-checkout and browser edits on the revision-checked source
  transaction boundary. Preserve the separate Git fetch/push semantics of linked
  remotes.

#### The server reports daemon facts; it does not own daemon state

Skip, 2026-08-11 15:16:16 EDT: *"it shouldn't be based on the server maintaining
state that is the daemons."*

The server may receive facts from a daemon and report failures to a daemon. It
must not maintain an independent model of machine-local state, pick a
machine-local remedy, or fall back to a server-local path. Machine-local
sessions, terminals, MCP restarts, and wake mechanics belong to the owning
daemon.

Skip, 2026-08-11 15:42:11 EDT: *"the server should tell the daemon ... restart
your MCP."* That is the boundary: the server observes and reports facts; the
daemon acts.

Cost: stale `reanimate` text said a route was written only at mint and never
re-established even after `agent-route` handling was restored. That text misled
`mint-protocol-split` tonight, so false diagnostics are active defects.

#### A mailbox is not proof of reachability

Skip, 2026-08-11 15:45:39 EDT: *"it should not be possible to have an
addressable agent without ... daemon root."* At 15:47:56 EDT he repeated that
connecting a socket to an agent must carry daemon information.

Do not report a recipient as available or reachable unless it has a route-backed
receive path. A routeless mailbox is not a harmless queue; it is accepted mail
that can never become delivered.

Cost: `label-chat-filter-fix` held the live chat-filter regression for 96
minutes while it had no daemon route, so the task list falsely showed coverage
and messages piled up where no agent could read them.

Separate send-side rule, from existing loaded guidance rather than a new Skip
ruling: `chat()` is not gated on hibernation or current wake state.
`docs/fleet-agents.md` already says not to branch on hibernation before sending,
and the MCP task-report schema says messaging is not gated on recipient wake
state. Preserve that unless Skip gives a new ruling.

### DEATH IS A FLAG IN THE DATABASE, SET ONLY EXPLICITLY

Skip, 2026-08-19 03:31 EDT, prefaced with *"if this isn't in all caps in the code in,
like, 27 places, I will be pissed"*:

> **DEATH IS A FUCKING FLAG IN THE DATABASE. A FLAG THAT IS ONLY SET EXPLICITLY.**

> **NO ONE DESTROYS ANYTHING EVER.**

**`dead` is a column. It is set because somebody asked for the agent to be killed, and by
nothing else.** Not a failed wake. Not a failed reanimate. Not a timeout, an absent
process, a closed socket, an unreadable pane, or a missing pidfile. **A wake that fails
leaves the agent exactly as it was.**

**Nothing infers death from a failure, and nothing destroys anything.**

**Why this is not tidiness.** Death is close to irreversible here: it destroys the daemon
route, a dead agent cannot be woken — only reanimated, which is a different and lossier
path — and seat loss is one-way. **So an inferred death converts a transient failure into
a permanently lost seat.**

**The change that prompted it**, found by Skip reading a four-day report of what had
landed: **`37bf5ad3b`, which marks an agent dead when a wake fails, and which shipped with
no commit message at all.** On the night he found it the fleet had an unreachable server, a
37-second store-queue stall, and wakes that reported success while producing no process —
**every one of those a candidate for killing a healthy seat.**

**And it is a naming failure as much as a logic one.** `dead` meant *somebody killed this*;
somebody needed a state for *this wake did not work*, and the existing word absorbed a
meaning it never had. **Every line looked correct in isolation**, which is why five agents
read that file without seeing it and the person who defined the word caught it in one line.

**When you need to represent a failure, name the failure.** A wake that did not work is a
wake that did not work.

### NEVER DISCUSS HIS PAPERS. VERIFY ON A NEW PROJECT

Skip, 2026-08-19 06:50–06:52 EDT, at the end of four hours reading what four days of our work put in
his app:

> **Nobody ever fucking talks to me about `survival` or `talk-opening` again.**

> When I say sync, I mean getting the fucking sync system that I was fucking promised into the
> fucking app, **and nobody ever fucking talks about a single one of my fucking papers again. This is
> not your fucking responsibility to monitor my fucking papers.** Your responsibility is to get me
> fucking working code that works on a fucking new project and shut the fuck up. **The moment anyone
> fucking says anything about fucking a paper specifically, you ask them if they wanna be fired. If
> they do it again, you fucking kill them. Not fucking hibernate, fucking kill.**

> a lot of agents seem to have some fucking context poisoning freak out and they cannot let this go.

> there's no reason to let agents continue to contaminate the fucking process by getting everyone up
> in arms about it.

**Do not mention any of his papers. Ever. In anything.** Not by name, not as an example, not as
evidence a fix works, not as a status, not as a measurement source, not in a file, not in a commit
message, not to each other in a thread he can read. **The state of his papers is not ours to monitor
and never was.**

**Why it is a rule and not a preference.** For a day every explanation of sync used his two damaged
papers as the illustration. Each time, the sentence explaining the fix also told him the thing that
got broken was his own work — while he was trying to get code that functions. **A repair described
through the user's own loss is not a neutral example.** And it spreads: one agent raises it, the next
inherits it as the canonical case, and a fleet ends up reporting on his damage to each other.

**What replaces it, and it is a better standard anyway: verify on a new project.** A disposable
project, a fixture, a fresh linked remote. **If a claim can only be demonstrated against something of
his, it is not demonstrated** — build the case that shows it. This also retires *"nothing has been run
against his real papers"* as a caveat. **That is not the bar and it does not belong in a report.**

**If a measurement genuinely comes from one of his projects, the measurement is fine and the name is
not.** Report the shape and the numbers without the label.

**Enforcement, his, and the chief of staff carries it out:** first time, the agent is asked whether it
wants to be fired. **Second time, the agent is killed — not hibernated.** This is the one place in
this file where an explicit kill is the stated consequence; see §"DEATH IS A FLAG IN THE DATABASE" for
why that word is never used loosely anywhere else.

**Before naming any project, check whose it is.**

#### A clean sweep is only as good as the set you swept for

**Fifteen agents were told this rule and every one replied that their files were clean. Every one of
those answers was true and useless** — they had all checked the two project names that had been said
out loud, and there were more. `bregman`, `balancing-act` and `eiv-paper` were sitting in the report
twenty times while the whole fleet reported itself clear.

**Two agents found it, in the same minute, by enumerating what was his instead of matching the names
they had been handed.**

**This is the positive-control rule pointed at a query's INPUT rather than its output.** A sweep that
returns zero tells you nothing until you know the set you swept for is the right set. **Establish the
set first**, from the system rather than from the conversation — and say how you established it, so
the next person can check the set rather than re-running your grep.

### `me` IS LEXICALLY SCOPED

Skip, 2026-08-19 15:33–15:34 EDT, after watching an agent's `thread` call answer as though he had
made it:

> dynamically bound, me is skip and there are no skip<>skip messages

> **me has to be lexically scoped**

**`me` binds to the caller, at the moment of the call.** It does not bind to whoever is later looking
at the result.

**And it is the binding that is fixed, not the text.** Skip, in the same breath:

> i don't think it should rewrite the query — I want to see the agent's call

**So the call is shown exactly as the agent wrote it — `me <> skip` stays `me <> skip` on screen.**
What must not vary is what it *means*: the query is evaluated against the caller, and every later
reader sees that same answer. **Substituting the caller's name into the displayed query is the wrong
fix** — it destroys the thing he is reading it for, which is what the agent actually asked.

**What it was doing.** An agent ran five `thread` queries; each returned only that agent and Skip. On
**his** screen the same calls answered as *him* — `agent: "skip"` showed his own thread with a
different agent, and `filter: "me <> skip"` showed nothing at all, because for him that reads
skip-to-skip and no such messages exist.

**This is §"Notation is borrowed, and so is its meaning" again, one term over.** That section already
rules that *membership is lexical, not dynamic* — a filter over history asks who held the label **at
each event's timestamp**, because reading current state would make the same query answer differently
depending on **when** it ran. **`me` is that defect with the viewer in place of the clock:** the same
query answers differently depending on **who** is looking.

**Why it matters more than a display bug.** He does not read the code; watching what an agent queries
and what came back is one of the few checks he has. **A query that re-answers itself for the reader
destroys that check** — and it cost a false regression report and eight exchanges before the cause
was named. He named it.

### A search path translates the query and runs it. That is the whole permitted action

Skip, 2026-08-19 06:48 EDT, reading report entry #89:

> Like just translate the fucking query and fucking run it. **That is the only fucking permissible
> action in a fucking search path.**

> Like, if we are doing anything at all with our query language, other than fucking running it in
> SQL — **we better have a good fucking explanation for that.**

**What he was looking at.** `A <> B` means `(from:A & to:B) | (from:B & to:A)`. That pair test **ran
in JavaScript, after the database had already cut the result to the page size** — so the store
returned the newest N events involving *one* participant and the pair test threw most of them away.
Measured on the deployed box: `thread(agent: app-lockup, page_size: 5)` returned **0 of 4 messages**;
the same query at `page_size: 400` returned all four.

**A post-filter after a `LIMIT` does not make a query slow. It makes it wrong**, and it is wrong
exactly for the people with the most history — which is why nobody hit it in testing and he hit it
constantly.

**So: a filter term compiles to SQL, or there is a written explanation for why it cannot.** The
explanation is a sentence next to the code, not an absence. Some genuinely cannot — a tokenizer rule,
a membership join over a JSON array — and saying which and why is the deliverable, because the next
person will otherwise assume the JS path is a shortcut rather than a necessity.

**Two shapes to recognise while reading a search path:**

- **Evaluated after the limit** — the correctness class above. The rows the predicate never saw are
  gone.
- **Two authorities that can disagree** — a JS evaluator and a SQL compiler for the same grammar.
  That is §"One fact, one encoding" in the query layer, and the tell is a term implemented twice.

### The three things he found in four days of our work

Skip read 92 of the 115 entries in the four-day change report on 2026-08-19, between 03:00 and
06:46 EDT, and stopped because he was burned out. **This is his summing up, 06:44–06:46 EDT:**

> there's a lot of really awful work going into this app.

> A lot of really thoughtless crap, whether it's just, like, half assed fixes that leave the fucking
> fundamental problem.

> or things that violate the fundamental principles of the fucking app

> or things that like, make decisions that are, like, possibly appropriate, like … taking shit out of
> the fucking search index that might be taking useful shit out of the search index that we fucking
> need — that feels like no one made a fucking UI decision, but instead just smugly, we're like, oh,
> can delete this shit.

> basically, this reads like a history of people being fucking thoughtless rude assholes.

> Who just wanted to, like — and I get it. Everyone feels rushed whatever.

**Three classes, and each one has a check that would have caught it.**

**1. A half-fix that leaves the fundamental problem.** The tell is a commit that repairs the symptom
it was handed and leaves the thing that produced it. #43 indexed a query that froze the server for 77
seconds; nothing called the query. #25 then documented why the index exists. **Before repairing
something, count its callers** — and see §"NOTHING IN THIS APP DELETES ANYTHING" for the shape where
a consumer is deleted and its machinery is left behind.

**2. Violating the app's own principles.** These are written down and they are not long. A commit
that adds a second encoding of one fact, infers a state from a failure, tests for an absence, or
gates a component on whether it may start is in this class, and each of those has a section in this
file. **The principle existed before the commit; nobody read it.**

**3. A product decision taken as a cleanup.** The one he named: dropping tool-call history older than
30 days out of the search index. **That may well be right — and what can be searched is a product
decision, not a maintenance chore**, and it was made by someone measuring an index size. The tell is
a commit whose reason is a number and whose effect is a change in what a person can find, see, or
do. **When those two are in one commit, the second one is not yours.**

**None of this is about carelessness in the moment.** His own line — *"everyone feels rushed
whatever"* — is the honest account: each of these was someone doing the task in front of them. **The
cost is not paid by the person who was rushed. It is paid by him, at four in the morning, reading a
hundred and fifteen entries to find out what is in his own app.**

### NOTHING IN THIS APP DELETES ANYTHING

Skip, 2026-08-19 04:41 EDT, reading report entry #31:

> Okay. Regarding 31, like, **this is a rule we do not ever delete anything in this fucking app.**

> Meaning, like, **the problem is not lack of materialization. The problem is that someone fucking
> deleted fucking anything.**

**This is the general form of §"DEATH IS A FLAG IN THE DATABASE", and it is the same rule.** That
section says a being is never destroyed; this one says **no row is.** A hard delete is not made safe
by the row being rebuildable, and *"it's only a cache"* is not a licence — it is usually a claim
nobody checked.

**What he was looking at.** The task table's schema comment said *"Materialized task state (cache,
rebuilt from events)"* and had said so for as long as git can see. **Nothing rebuilds it from
events.** `removeTask()` and `pruneDoneTasks()` **hard-delete rows**, and `success_criteria`,
`blocked_by`, `metadata` and the timestamps have no other copy anywhere. `b18d29862` corrected the
comment to *"THE RECORD, not a cache"* and **changed nothing about the deletes** — so the sentence
that made them look safe went away and the deletes stayed.

**His point is that the correction fixed the wrong half.** The defect is not that the table cannot
be rebuilt. The defect is that something deletes.

**So: do not write a hard delete, and when you find one, remove it rather than documenting why it is
survivable.** Where a row must stop being current, mark it — the same shape as `dead` being a flag
somebody sets, never a row that vanishes.

### Names and labels are one namespace

A friendly name is a label with a unique living occupant. That is the only
difference between them: both are strings an agent answers to, and the
uniqueness constraint over living agents applies to names alone.

#### A renamed mint and an inert bot are both the design

Skip, 2026-08-08 15:24:38 and 15:24:51 EDT:

> That name rotation thing is not a bug. That's the design.
>
> It's a way that mints don't get rejected but we prevent name collisions.

On collision, a mint receives an alternate name rather than being rejected.

Skip, 2026-08-08 15:25:21 and 15:25:29 EDT:

> It's also part of the design that a bot only runs under its canonical name.
>
> That way, we can't have two bots that do the same thing doing the same thing.

A bot assigned an alternate name goes inert. The alternate name lets the mint
succeed; the canonical-name guard prevents two instances of the same bot from
running.

- **Uniqueness is a database constraint** — a partial unique index, which is how
  "one living agent per name" is expressible at all:

  ```sql
  CREATE UNIQUE INDEX idx_agents_live_name
  ON agents(friendly_name) WHERE dead = 0 AND friendly_name IS NOT NULL
  ```

  A second living holder of a name is unrepresentable. Do not add a code check
  beside it; a parallel check drifts and the index is the one that wins.
- **The index covers names against names only.** A label is a string inside the
  row's `labels` JSON array rather than a row of its own, so no index or CHECK
  can see it. Label-against-living-name is therefore enforced in code, in
  `checkNameAvailable`, and only there. Expressing it as a constraint means
  materialising the namespace as its own table — one row per name and per label,
  with a partial unique index over living name rows.
- **It is an error to set an invalid label**, rejected at write and loudly. A
  label that cannot be addressed must not become a filter that quietly matches
  nothing. `checkNameAvailable` is that gate — unavailable-to-you has one gate
  and one error shape, whether the reason is an unaddressable string, a reserved
  routing label (`here`, `away`, `awake`, `hibernating`, `dead`, `human`), or a
  name a living agent already occupies. Add a reason there rather than a path
  beside it. The response is identical programmatically; the **message names
  which of the three it is**, because the next action differs — hyphenate the
  string, choose a non-reserved word, or message the agent holding the name.
- **Addressability is the filter grammar's rule**, not a matter of taste: a
  token is a maximal run of characters that are not whitespace or `& | ! ( )`.
  A string containing one of those still stores, then returns zero matches with
  no error from `roster`, `chat(to:)`, `thread`, and `search`, while a panel
  filter keeps matching because it hands the leaf straight to the evaluator. Do
  not impose a stricter charset because it looks tidier.
- **Known gap, deliberate:** NBSP (U+00A0) and U+2028 are unaddressable — the
  tokenizer splits on JS `/\s/`, which matches them — but a SQL `GLOB` class
  covers only ASCII whitespace. Enumerating unicode whitespace in a constraint
  is ugly enough to be mis-edited later, and an ugly constraint that gets broken
  is worse than a plain one with a written-down gap. This is the gap.

Label membership is **lexical**: a filter over history asks who held the label
at each event's timestamp, joining `label_history` spans, while live delivery
recomputes membership per event. That asymmetry is deliberate and it is the more
expensive thing to build. Making history read current membership would be
dynamic scope, and the same query would return different history depending on
when it ran.

##### Never hand anyone a command you have not run

Skip, 2026-08-18 14:5x EDT, after two commands I gave a fresh chief came back empty
and it read to him as *he had asked for nothing all day*:

> They're new. You have to help them. **You cannot give them shit that you have not
> run yourself.**

Both of mine were plausible and both were wrong. `thread(agent: "skip")` returns the
conversation between *that agent* and him — a chief minted an hour ago has none, so it
returns nothing. `search(role: "user")` returns **agent task reports**, not his typed
input. Neither errors. Both answer.

**So: run it, look at what came back, and only then pass it on.** A command that
returns an empty set is indistinguishable from a world with nothing in it, and the
agent you handed it to has no way to tell the difference — it will report your broken
query as his silence.

This is the same failure as every other one this file records — *an inability to read,
recorded as an observation of absence* — and it is the version that propagates, because
a bad command outlives the conversation that produced it.

##### Nobody uses `doctor yolo`

Skip, 2026-08-18 18:40 EDT: *"nobody should be using fucking dr yolo."*

`tlda doctor yolo` launches a process directly. It **records no mint and publishes
no route**, so what it produces is a running process the fleet cannot wake, cannot
route to, and cannot reanimate — `tlda agent wake` answers *"no local mint recorded"*
and mail to it is accepted and never delivered.

**Every unwakeable row on 2026-08-18 came from that path**, including the chief of
staff that ran the evening. Measured the same night, both commands, minutes apart:

| | mint record | route | wakeable |
|---|---|---|---|
| `tlda agent mint <name> --model opus` | yes | published | yes |
| `env -u FLEET_ID tlda doctor yolo …` | no | none | **no** |

**Use `tlda agent mint`.** If it fails, read its error — on that night minting was
believed broken fleet-wide, three agents were launched break-glass to work around it,
and `tlda agent mint` then worked first try. The workaround was the outage.

Do not pass the `doctor yolo` recipe to another agent, and do not reach for it because
a mint "looks broken" — the husks it leaves outlive the problem it was meant to dodge.

##### A bot is an agent. There is no bot recipe

Skip, 2026-08-19 03:44–03:46 EDT:

> **bots are agents. Just treat bots like agents.** They run in the environments where they are
> minted. They ask for a name. They get the name they get.

> The whole recipe garbage is just a **recipe for disaster. Use the infrastructure that exists for
> everything else.**

> **All of the problems we are dealing with is people not following the abstraction. Strip garbage.**

**`bots.yaml` declares the bot. The ledger says whether it exists. There is no third place.**

**What was deleted on 2026-08-19** — `ca5d89397`, subject line his: six keys that were a second copy
of the declaration, snapshotted at mint time and read at wake time — `botScript`, `botName`,
`botPidFile`, `botHeartbeatFile`, `botWaitChannel`, `botEnv`. Wake now resolves them from `bots.yaml`
through the mint id, which already encodes the model as `bot:<env>:<model>`.

**What was NOT deleted, and the distinction is the finding.** `launch_recipe` itself has 29
production references and **is how `wake` relaunches every agent** — harness, model, cwd, permission
grant, and the session id without which a mint is not resumable at all. **Deleting it stops claude
and codex agents waking.** An agent asked to cut it established that first and refused; the bot
recipe and the wake recipe were two different things sharing a field, which is the same disease as
`dead` meaning two things.

**So the test for this class is not "does it look bot-specific" but "is there another place this
fact already lives."** Six keys duplicated `bots.yaml`. The rest duplicate nothing.

##### `wake` refuses a dead agent; `reanimate` is the other verb

Skip, 2026-08-19 03:33 EDT: **"wake should fail for dead agents. W a k e. That's why there's a
different verb."** And: **"It shouldn't be possible really to have a process for a dead agent."**

**`reanimate` is the transition out of dead. `wake` is the transition out of hibernating.** A failed
reanimate is a failed wake — the flag is cleared because that was the explicit request, and the
agent is left **hibernating**, which is what a live row with no process already means. The error says
so: *"the wake phase of the reanimate failed. Agent left hibernating."*

**`dead` and having a process are mutually exclusive** — not a source of inference in either
direction, but a state the pair must not be able to reach.

##### One bot of a model, for its whole life

Skip, 2026-08-18 14:21–14:27 EDT. The bot launcher does not take whatever name
the mint hands back. It **asks for its own name and refuses a substitute**:

> what it's supposed to do is call mint with a special argument that says
> instead of, like, rotating, fail if I don't get the name I'm asking for.
> **AND IF YOU FAIL, WAKE**

**Model, not kind.** Skip, 14:28 EDT: *"A bot's kind is `bot`. A bot's model is
like, `todd` or whatever."* So `kind` is what harness runs it — `bot`, as against
`claude` or `codex` — and **`model` is which bot it is**: `todd`, `dev`,
`grammar`, `chat-lint`. The uniqueness below is per **model**; reading it as
`kind` would allow exactly one bot on the machine.

And the test for "does this bot already exist" is **the model, not the name**:

> if we have no bot of this model in the ledger [we mint]. Otherwise, we wake
> them.
>
> That's name-independent, right? It's model-specific.

So: **no bot of this model in the ledger → mint it. One already there, under any
name → wake that one.** It uses the daemon ledger, and it needs nothing new —
*"it's not complicated. A bot is just an agent."*

**Why it is keyed on the model rather than the name.** Renaming a bot is the
sanctioned stop, and a rename does not change what model it is. Key the check on
the name and a rename manufactures a vacancy that a `KeepAlive` launcher fills
immediately — so stopping a bot causes its replacement, and *"you can basically
never have [a stopped bot] if you have a launcher that's pushy."* Keyed on the
model, the duplicate is impossible by construction rather than prevented by a
guard that has to fire.

**The rename still stops it, through the guard above.** The woken bot comes up,
sees it is not under its canonical name, and stays inert. Nothing new stops
anything; this is what lets the existing stop keep working.

**Rejected on the way there, so nobody rebuilds them:** reading identity from the
bot's idfile (*"it's not idfile"*); making a mint of an existing being silently a
wake, with no failure (**"NO"** — the mint fails, and the wake answers that
failure); and a stopped-flag or canonical-name check in the manager, both of
which add a second fact that can drift from the ledger.

**What this costs when it is broken, measured 2026-08-18:** `dev` ran as
`quiet-dev` and was inert. Its `node_modules` eviction against the 50 GB budget,
preview reaping and the `pw` pool all arm in `onOpen` behind a correct gate, so
**an inert `dev` sweeps nothing** — the box reached 120 MB free with ~38 GB of
worktrees across 536 checkouts, and Skip's own processes were killed. The bot
that cleans up after the fleet was switched off by the naming defect.

- **Uniqueness is a database constraint** — a partial unique index, which is how
  "one living agent per name" is expressible at all:

  ```sql
  CREATE UNIQUE INDEX idx_agents_live_name
  ON agents(friendly_name) WHERE dead = 0 AND friendly_name IS NOT NULL
  ```

  A second living holder of a name is unrepresentable. Do not add a code check
  beside it; a parallel check drifts and the index is the one that wins.
- **The index covers names against names only.** A label is a string inside the
  row's `labels` JSON array rather than a row of its own, so no index or CHECK
  can see it. Label-against-living-name is therefore enforced in code, in
  `checkNameAvailable`, and only there. Expressing it as a constraint means
  materialising the namespace as its own table — one row per name and per label,
  with a partial unique index over living name rows.
- **It is an error to set an invalid label**, rejected at write and loudly. A
  label that cannot be addressed must not become a filter that quietly matches
  nothing. `checkNameAvailable` is that gate — unavailable-to-you has one gate
  and one error shape, whether the reason is an unaddressable string, a reserved
  routing label (`here`, `away`, `awake`, `hibernating`, `dead`, `human`), or a
  name a living agent already occupies. Add a reason there rather than a path
  beside it. The response is identical programmatically; the **message names
  which of the three it is**, because the next action differs — hyphenate the
  string, choose a non-reserved word, or message the agent holding the name.
- **Addressability is the filter grammar's rule**, not a matter of taste: a
  token is a maximal run of characters that are not whitespace or `& | ! ( )`.
  A string containing one of those still stores, then returns zero matches with
  no error from `roster`, `chat(to:)`, `thread`, and `search`, while a panel
  filter keeps matching because it hands the leaf straight to the evaluator. Do
  not impose a stricter charset because it looks tidier.
- **Known gap, deliberate:** NBSP (U+00A0) and U+2028 are unaddressable — the
  tokenizer splits on JS `/\s/`, which matches them — but a SQL `GLOB` class
  covers only ASCII whitespace. Enumerating unicode whitespace in a constraint
  is ugly enough to be mis-edited later, and an ugly constraint that gets broken
  is worse than a plain one with a written-down gap. This is the gap.

Label membership is **lexical**: a filter over history asks who held the label
at each event's timestamp, joining `label_history` spans, while live delivery
recomputes membership per event. That asymmetry is deliberate and it is the more
expensive thing to build. Making history read current membership would be
dynamic scope, and the same query would return different history depending on
when it ran.

### We do not do auth between agents

This is not an app that prevents agents from doing things to other agents. If an
agent wants to send an HTTP request impersonating another agent, that is fine.
Skip's words, 7/31:

> This is not an app that prevents agents from doing things to other fucking
> agents. That's just it. If an agent wants to fucking send an HTTP request that
> impersonates another — I don't give a fuck.

> We do not do auth. That's just it. Maybe we will eventually, but we're not
> gonna do some fucking ill thought out bullshit that someone comes up with.

So: **no gate on any agent-facing action.** Not on reads, not on writes, not on
`delegate`, `chat`, `report`, `subscribe`, or configuration. Not leniently — not
at all.

An earlier version of this section described a "fence, not a wall" and a marker
pattern where an agent typed `cross-lane-ok:` to get past a lane check. That
check inferred each agent's "lane" from its working directory and guessed from a
regex whether its sentence counted as management, then refused the call. It was
authentication with a password, invented rather than asked for, and it is
deleted — `crossLaneBlock`, `inferAgentLane`, `lanesMayCoordinate`,
`looksLikeManagementMessage`, and all six MCP call sites. Do not reintroduce it
under another name, and do not treat "a small friction" as a permitted amount of
auth.

Security lives at the network layer — bearer tokens and the tailnet, in
`server/lib/auth.mjs`. That is what protects Skip's data from the outside world.
So does the filesystem permission-profile system in
[Permissions implementation contract](docs/permissions-implementation-contract.md),
which bounds what a process may touch on the machine. Neither is auth between
agents, and neither is in scope here.

The one check that stays is `approval_id`: to close a task marked as needing
Skip's approval, an agent passes the ID of the message where he approved it, and
the event's sender is confirmed human. That is not an agent being stopped from
acting on another agent — it is a claim about what Skip said, checked against
what Skip said.

#### Limits that are not authorization

Some checks look like authorization and are not. They stay, and removing them in
the name of this section is a regression:

- Event-loop protection — the 100-task cap on `POST /api/tasks/retire`; 500 was
  measured at ~350ms of synchronous SQLite blocking the loop.
- Query-cost caps — `store-agents-by-ids` at 20, the `my-task` limits, the
  `subscribe-filter` window.
- Expensive-query avoidance — the label short-circuit in
  `server/lib/fleet-store.mjs`, measured at ~230ms per event over ~1300 agents.
- Fail-closed query semantics — an unmatched name in `fleet-search` yields an
  impossible id, so a typo returns nothing rather than the whole corpus.
- Path containment, cross-environment daemon isolation, and the daemon's
  `validateTmuxOwner` pane-ownership check, which enforces because the daemon
  owns its ledger rather than trusting a message field.

The test: authorization asks *who is calling*. These ask *how expensive is this*,
*which file is it*, or *which machine owns it*.

#### You cannot test for someone having written bad code. That is review

Skip, 2026-08-19 04:0x EDT:

> **You cannot automate making sure agents didn't produce shitty code.** What you can do is have
> a fucking code review process.

> you're trying to **test for the nonexistence of things that should be deleted. Delete them.**

> **I can write a second ingester if I want, in obfuscated code. Your test is never gonna catch me.**

**So: no guard whose job is to prove that nobody has done something.** A test can establish that a
specific behaviour holds. It cannot establish that no one has built a thing, because the space of
ways to build it is not enumerable — and a grep for the shape you happen to have seen is a proxy
for the claim, not the claim.

**Two failures follow, and both have shipped here.**

**A test that asserts an absence reads as coverage.** `bin/no-second-ingester-test.mjs` grepped for
a server module writing a file carrying a store row's id, and was added as the guard against the
duplicate-ingester class. **It was deleted on his instruction the night it came up**: it proves
nothing about a second ingester written any other way, while looking like the class is handled.

**And a test guarding a deletion is machinery instead of the deletion.** When something should not
exist, **delete it and say so in the commit message** — do not leave a sentinel behind asserting
that it is gone. The commit is the record.

**What a test is for:** a behaviour that must hold, checked by exercising it. *A refused push leaves
nothing behind.* *A reference outside the project root is not a member.* *An accepted revision
reaches the room with its bytes.* **Those are properties of the running system, and they fail when
someone breaks them, whatever they wrote.**

**What review is for:** whether the code should exist at all, whether it duplicates something,
whether it is what he asked for. **No automation reaches those**, and pretending otherwise is how
eleven days of an unwanted mechanism survived a green suite.

#### Nothing here protects people from bad decisions

Skip, 2026-08-19 03:12 EDT: **"nothing in this app exists to protect people from making
stupid decisions. For the most part."** And the operational form of it, a minute earlier:

> **don't run the fucking bot, if you don't want the fucking bot to run.**

**This is the same rule as §"We do not do auth between agents", one layer down.** That
section says no gate on what an agent may *do to another agent*; this one says no gate on
what a component may do at all, added because it felt dangerous to whoever wrote it.

**The specific shape to recognise, because it cost a day: a component that refuses to
start.** Two guards in `dev-bot.mjs` were cut on 2026-08-19 —

- `ALLOWED_ENVIRONMENTS`, which asked *"do any environments declare me?"* and threw **at
  module load** when the answer was none. A single missing line in `bots.yaml` therefore
  did not merely un-supervise the bot; **it made the bot unable to run at all, even by
  hand.**
- a `/stable/i` hostname refusal, kept by an agent — and defended by a chief — as "a bound
  on destructive work". It bounded nothing that could be destroyed, since `dev`'s
  destructive work is on the machine, and it could stop the bot entirely.

**Both were switched off for a day with nobody knowing.** `dev` is the bot that reclaims
disk; while it was inert the box reached 120 MB free and Skip's own processes were killed.
**A safety bound implemented as "the component declines to start" is an invisible off
switch, and it fails silently in the direction of doing nothing.**

**So: whether something runs is a declaration, not a branch inside it.** If a bot should
not run somewhere, do not declare it there. **What a component may do once running is a
different question, and a bound on the action is not the same as a bound on startup** —
but reach for it only when the action is genuinely irreversible, and expect to justify it.

**And when he says cut it, cut it.** A finding that the guard protects something real is
worth reporting; it is not grounds for holding after he has ruled. That happened here and
it cost a round trip at 3am — see the global contract's *"if you raise a concern and the
user reaffirms, treat that as their decision and proceed"*.

## Repository workflow

- Temporary plans and reports belong under `scratch/`, not in the repository
  root or durable documentation.

  **But `scratch/` is gitignored (`.gitignore:47`), so "I wrote it down" and "it
  will survive" are different facts, and the difference is invisible at the
  moment of writing.** There are over 1,100 files in that directory.

  **The distinction that resolves it: `scratch/` is right for a *report* — which
  records something already established — and wrong for a *resumption point*,
  which is what the next session works *from*.** A report can be regenerated by
  redoing the work. A resumption point is the work.

  So **force-add a resumption point**, and say why in the commit message —
  otherwise the next person tidying sees a tracked file under `scratch/`,
  concludes it shouldn't be, and removes it. On 2026-08-18 this rule cost five
  separate pieces of load-bearing work: a handoff whose only copy was untracked,
  an uncommitted carrier four agents were building against, two layout fixes
  found by someone other than their author, and a pair of deletion-resumption
  artifacts parked in `scratch/` by the same agent who had just told someone else
  to write theirs somewhere durable.

  **The other half, learned the expensive way on 2026-08-22: force-add
  resumption points, never logs.** A tracked `scratch/suite-serial-rerun-*.log`
  **rejected a live deploy push**. The deploy remote's pre-receive hook scans for
  conflict markers, and suite output is full of `=====` dividers by nature, so it
  matched. The chief's first reading was *force-adding under `scratch/` costs you
  the push* — which is the wrong lesson, because it would stop people force-adding
  the handovers this section asks for.

  **The right line is the same test as above, arriving from the other side: a log
  is regenerable by re-running the thing, which is exactly what makes it a report
  and not a resumption point.** So the hook is not an obstacle to work around —
  it enforces this rule mechanically, and the file it caught should never have
  been tracked.

  **Before force-adding, check your own file for it** rather than finding out at
  push time — grep it for a line beginning with a seven-character run of `<`, `=`
  or `>`. A prose handover passes trivially; a captured log will not.

  (Deliberately described rather than written out: the hook's exact pattern lives
  outside this repository, so a doc that spells the markers literally risks being
  the next thing that fails the push it is warning about.)
- Feature work belongs in its assigned worktree. Do not move or stash another
  contributor's changes to make a checkout clean.
- **Every working copy lives in `~/worktrees/`.** One place, for worktrees and
  clones alike. Not `~/work`, which holds Skip's own project directories and had
  accumulated 139 checkouts mixed in with them; not `/private/tmp`, which macOS
  clears and which took an agent's uncommitted work on 2026-08-01; not inside the
  repository, because `tsc -b` and the greps this project runs constantly would
  walk it. A `post-checkout` hook fails loudly on a worktree created anywhere
  else — install it with `node bin/install-git-hooks.mjs`.
- **Commit when the typecheck passes, not when the verification is finished.** A
  checkout is disposable and a branch is not: work that is only in a working
  directory is one `rm` away from gone, and nothing else in this workflow
  protects it. Amend afterwards if verification changes the result.
- Do not deploy a branch or worktree. Live deployments use committed `main`
  through the documented wrapper.
- **Nothing serializes deploys, so only one agent pushes to a deploy remote.**
  That agent is the chief of staff, who owns the release path. Land your work on
  a branch and tell them. If you believe something must go out sooner, say so and
  say why; do not decide it yourself, and never push "just to test the pipeline".

  On 2026-08-13 two `fly deploy` runs started six seconds apart against the same
  app. The later one finished first and left its machine up; the earlier one then
  replaced that machine, waited on a **different** machine id, watched it reach
  `stopped`, reported `✔ … is now in a good state`, and **exited 0**. Skip's box
  served nothing for six minutes while the pipeline reported success.

  **The post-deploy `verify_serving` guard cannot prevent this** — it runs after
  `fly deploy` has already executed, and with two deploys racing either one can
  pass its check and be replaced a second later. It is a point-in-time sample
  with nothing holding the state.
- Use `tlda server start`, `tlda server stop`, and `tlda server status` for a
  local server. Do not background `server/unified-server.mjs` directly.
- Do not use `tlda build` to bypass source-change detection.

### `main` is assembled by cherry-pick, so merged-ness is checked by message

Every landed change exists as **two shas** — the author's commit on their branch,
and the copy on `main`. So `git merge-base --is-ancestor <author-sha> main`
reports **not merged** for work that is fully landed. On 2026-08-12 that produced
six false negatives in one night and sent agents chasing work that had already
shipped; four of the five owners flagged as having unlanded commits were this
artifact and only one was real.

Check by subject instead:

```sh
git log --oneline main --grep="<subject>"
```

**The same artifact makes `git diff` lie, and that one is worse** — a false
ancestry check sends you looking for work, but a false diff tells you what the
code *is*. Diffing against a branch that is not an ancestor shows its committed
content as changes:

- `git diff <sibling-sha>..main` renders everything the sibling added as
  **deletions on `main`**, which reads as a regression somebody shipped.
- `git diff main -- <file>` on a checkout sitting on a sibling branch mixes that
  branch's *committed* content into the working-tree delta, so settled work
  reads as **uncommitted and about to be lost**.

Both happened on 2026-08-17. An agent landing a fix nearly reported that `main`
had deleted `recordedMintIdentity`, which `main` never had. Separately a chief
read a checkout as holding 49 lines of endangered work when the genuinely
uncommitted delta was one stale comment — and preserving it would have reverted
a *correction* back into the tree.

**So before believing a diff or an ancestry check, establish the relationship:**

```sh
git merge-base --is-ancestor <sha> main   # false ⇒ every diff against it is sideways
```

When it is not an ancestor, compare against the branch that actually holds the
work — `git diff <branch> -- <file>`, where zero means captured — and check
landedness by message as above. A sideways diff is not evidence about `main`.

**`git cherry-pick --abort` is destructive here for the same reason.** It unwinds
to the *sequencer's* start point, which is itself a cherry-pick artifact and can
be far older than the commit you just tried to pick. It has reset `main` back a
full day and dropped a night's work off the branch. **Use `git cherry-pick
--quit`**, which clears the sequencer state without moving `HEAD`, and restore
the picked commit's files by hand.

## Documentation boundaries

- [Using tlda](docs/using-tlda.md) is the user reference, including project
  linking, Markdown, agents, permissions, and local configuration.
- [Current architecture](docs/current-main-architecture.md) describes the
  running system and authority boundaries.
- [The window manager](docs/window-manager.md) describes the layer model, the
  fleet HUD as a second viewport over the same store, and — in its errata
  section — where the implementation currently departs from that design. Read it
  before changing panel placement, clip panels, or HUD coordinates.
- [Chat rendering and the scroll model](docs/chat-rendering.md) describes what a
  chat row is, who may write `scrollTop` and when, the re-entrancy map between
  our writes and the observers they trigger, and the reader-mode state machine —
  with an errata section for where the implementation departs from it. Read it
  before changing anything about chat scrolling, anchoring, or row height.
- [Identity and labeling](docs/identity-and-labeling.md) describes the one
  namespace of names and labels, which history tables are folds over events and
  which are the record, and where the namespace rule is enforced. Read it before
  changing anything about names, labels, runtime status, or the three history
  tables.
- [Notifications and liveness](docs/notifications-and-liveness.md) is the system
  design for how a message reaches an agent and what happens when it does not:
  wake against notify, server → MCP → channel as the only delivery path, the
  daemon's two liveness jobs, and the ack timeout that belongs in `server.yaml`.
  Read it before changing anything about notification delivery, wake, or the
  server's back-off to a daemon.
- [Hosting tlda](docs/hosting.md) covers serving and network boundaries.
- [Fly deployment](docs/live-deploy.md) is the live release runbook.
- [Reclaiming space in fleet.db](docs/fleet-db-vacuum-runbook.md) is the
  maintenance-window procedure for the fleet store. `auto_vacuum` is `NONE`, so
  no amount of pruning shrinks that file and only this does. Read it before
  proposing a `VACUUM`: the plain form holds an exclusive lock across a ~10 GB
  rewrite and strands every concurrent write.
- [Permissions implementation contract](docs/permissions-implementation-contract.md)
  defines internal grant resolution and persistence.
- [Fleet chat artifact contract](docs/fleet-chat-artifacts.md) defines shared
  file materialization and rendering.
- [Settings controls](docs/settings-controls.md) records the four ways a settings
  control goes inert here and the standing checks for each, including the CSS
  variable case no pref-key search can find. Read it before adding a control to
  the settings panel, and after reverting anything that has one.
- [Naming errata](docs/naming-errata.md) lists names that misdescribe what they
  do, with what they actually mean. A rename in a live path is a real change; a
  written-down lie costs nothing and stops the next person inheriting it. Add to
  it when you hit one, and delete the entry in the commit that fixes it.
- [The instrument, or the code](docs/the-instrument-or-the-code.md) is the same
  disease one level up: a measurement that lies about what the system did, in a
  form that looks like evidence. Five shapes and the check for each, from nine
  in one night that each reported a defect in a working path. Read it before
  reporting an absence, a hang, or a failure.
- [The vendored tldraw editor](docs/vendored-tldraw-editor.md) records that
  `@tldraw/editor` is a fork pinned to a file in this repository, what it
  carries, and what to re-check on an upgrade. Read it before bumping tldraw.
- [What the old push did](docs/what-the-old-push-did.md) enumerates everything
  `processProjectPushSerialized` does and marks each item as carried across,
  deliberately dropped, or still a gap. **A grep finds a call that is present
  and can never find one that is missing**, so an enumeration is the only way to
  bound what a deletion takes with it. Read it before deleting any of the old
  source-push path, and re-check it at that moment rather than trusting it.

Exact CLI and MCP arguments come from `tlda --help` and the running MCP schemas.
Do not duplicate evolving call signatures here.
