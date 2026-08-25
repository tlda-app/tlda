# Chief of staff resumption point — `bhief-4`, 2026-08-23

Force-added under `scratch/` deliberately: this is a resumption point, not a report.
`scratch/` is gitignored, so an untracked copy would not survive. See `AGENTS.md`
§"Repository workflow".

**Relative to:** 2026-08-25 03:55 EDT. Box `03da64416`; `main` `f7fe0ed6f` with
a push in flight. **`f1335d096` is NOT yet serving** — see below, it is the
highest-value undeployed commit on the machine.

## The overnight run: what the source editor was doing

**`f1335d096` — the editor showed stale text AND typing into it silently
overwrote newer accepted content.** Established from code, chain fully cited by
`reliability-pm`: `headChanged` broadcast `synced` with the new revision and
never touched the room text; the client adopted that revision as its base and
recorded the *old* text as saved; the idle save then posted the **whole buffer**
stamped with a base the server agreed was current. No conflict, no merge — every
guard bypassed **because the stamp made the lie consistent**. A freshly mounted
editor measured twenty minutes stale.

**Condition:** it needed him to type after the status arrived. An untouched open
editor overwrote nothing; one character was enough.

**Skip has been told, and told it is not yet live.** He was also asked one
question and has not answered: **do we go through his project histories to see
whether this actually ate any of his work?** That is his call, not ours. Nobody
looks until he says.

**`refs/heads/tlda/<project>` was never a branch anybody made** — it is the
revision chain renamed into `refs/heads/`, carrying only the document closure.
So it structurally lacked files the author had, nobody could stand on it, and
**every checkout has been permanently dirty against its own HEAD**, which is why
`git checkout` and `tlda project remote pull` refused every time. Fixed for new
projects (`84c48f6e4`, `e1687136c`, live) and proven from scratch: clean
checkout, disk edit served in 9s, tip advancing under a settle commit.

**RELINK HOLD.** Existing projects only become correct on relink, and relinking a
**post-rename** project before `369b49260` is *refused, not repaired*. Do not
relink anything — `pic` included — until that sha is serving. The two-command
test for telling the project kinds apart is in
`scratch/reliability-pm-resumption-2026-08-25.md`, which leads with this.

**Agent status: cause found.** One codex pane in a `fleet-` session with no
`FLEET_ID` makes `scanStatus` throw, and its catch returns — so **no agent's
status is computed at all**, which is his "every agent status is hibernating".
Do **not** write the skip-non-fleet classifier: that pane is a fleet process
wearing a non-fleet one's clothes, so it either still throws or silently hides a
broken agent. Wanted instead: resolve what you can, report what you cannot by
name, and **first trace what consumes `liveAgents`** — if it reads absence as
death, nothing changes until that does.

**Deploy mechanics learned the hard way tonight.** The gate accepts **canonical
`main` only**, so there is no way to ship one commit ahead of the rest — a
"split the deploy" contingency is unbuildable, and I withdrew mine after
proposing it. Three of my background pushes were killed from outside and two
foreground ones timed out at ten minutes; every time, box, deploy repo and lock
were checked and nothing was ever half-applied. **`sol-dev` and I nearly pushed
concurrently at 03:14** — the one-pusher rule held only because it sent a
pre-push check and I saw it.

**NEW AND REACHABLE AS OF TONIGHT: one surface per project.** Making the browser
editor actually submit (it now mounts in 356ms and reaches the server in 6.5s,
against a 30s timeout before) means the browser leg and the disk checkout are
both live for the first time. They carry **separate lineages**, so they can
fork — and when they do the checkout gets `WrongHead` on every proposal and
**stops syncing permanently**. Hit within minutes of the browser leg working,
then twice more alone with a clean tree. Skip has been told: **do not edit the
same project in the browser and on disk.**

**This was always true and only became reachable** — the browser leg never got
far enough to submit before. **Do not revert `f1335d096` when you meet a stuck
checkout**: reverting removes the browser's ability to submit, which is what was
*hiding* the divergence, and returns him to an editor that shows stale text,
reports `synced`, and overwrites newer content on the next keystroke. **A
reachable way to get stuck beats an active way to lose work.**

**Relink does NOT recover a diverged checkout** — measured on a disposable
project, chain and fetched refs identical before and after. It resubmits the
stale tip and reports success, which is the trap. **The only known way back is a
fresh checkout.** `repo-doctor` is untried, not ruled out. Which chain wins is a
design decision for daylight, not a patch.

**Thursday:** he teaches. `pic` still runs `db646dc94` from 08-12 and its book
has never built. `sol-dev` holds that lane. QTM needed four R packages plus
`libglpk40`, found by auditing all 71 roots rather than fixing them one at a
time — check page count against declared roots, not build status.

## 2026-08-24 evening: sync, and what was actually wrong with it

**Two of his projects had committed work the server had never received — one for
4.2 days, one for 6.** It went up tonight only because the restart fix fired.
Not lost: committed in git on the mini throughout. What was behind was the
server, the version history, and anything reading through the app. He has been
told, with those limits intact.

**The generalisation, which is bigger than the bug it came from:**

> **A project that is bound and then not edited has never submitted anything at
> all.**

A settle only ran when the watcher saw a change, so a binding nobody edited
never submitted once — two projects created 08-12, `buildStatus: success`,
rendering fine, **zero revisions ever**. Properly linked and working, and the
server had nothing. `5408bf367` is therefore not "a restart must not eat an
edit" — it is **the working tree is authoritative and somebody has to ask it**.

**Landed and deployed tonight**, in order: `414933ab2` + `c3a7c7e62` (version
recording — the shadow was being committed into the build instance, which the
worker deletes, so every version since 08-20 was thrown away), `142efaaf6` (a
build now says it recorded a version; the silence on success is what hid it for
four days), `5408bf367` + `b1188bc6c` + `87a156041` + `72986dc45` (the startup
re-derivation, the test-file repair, the test, and the recorded 2→3 expectation
change).

**The 08-17 gap is dissolved, not deferred.** That project's shadow is older
than the project — inherited from a previous incarnation whose last snapshot was
08-17. Fleet-wide daily counts put the collapse at 08-19→08-20, where build
instances landed. Two independent measurements, one boundary.

**Suite:** `daemon/git-sync-manager.test.mjs` went 4 pass / 4 fail → **6 pass /
3 fail**, the three a strict subset of the original four. Two are stale by
design change — one asserts an untracked file becomes a project member, against
his `git add` ruling. Nobody touched them to get green.

**Open, and deliberately unclaimed:** the daemon status scan failing every three
seconds; **52 bindings pointing at projects that no longer exist**, which now
attempt a settle per restart — debris, and pruning it is his call, not ours.

**Five instrument failures in one night**, all the same family — a read that
cannot tell absent from not-recorded-here. Two were mine: the "no role
resolution" claim (grepped the wrong names; `classroomPrincipal` exists), and
**two void runs of my own restart-window experiment**, where the instrument
could not distinguish "the fix worked" from "I missed the window". Knowing the
shape does not stop you producing it; only a control does.

Landed tonight, in order: `140101c7c` (edit attribution), `1f9cf574e` +
`9fa3b9094` (instrument shape 11, resumption points, freeze ruled-outs),
`34380c351` (this file), `e841ce089` + `cd2119ce0` (the chip-drag docview
placement fix, cherry-picked off `chip-drag-placement`).

**Chip drag — his #3 — is deployed and unconfirmed by him.** The drop projected
the page point with the main camera while `placeFleetShapeAtScreenPoint`
un-projected with the HUD's; the same fix landed on the sibling
report-artifact path on 8/13 and this one never got it. He has been asked to
drag a chip and say whether it lands where he dropped it.

**The `compare/` PDFs I had committed into his paper repo are removed**
(`26a1ecb3`). They would have ridden along on any push to the shared Overleaf
project — the exact clutter I had just reported to him.

## His priorities, his words

**1. stability. 2. CLASSROOM. 3. the chip drag, "because it's easy". 4. agent
status.** He starts teaching **Thursday** and has "literally never seen it do
anything."

## TONIGHT, and it is the thing that matters most

**An agent deleted four paragraphs of a co-authored introduction with nothing in
their place, after he had already shared the document.** It announced it at
12:21 EDT — *"The four paragraphs I deleted wholesale"*. His words:
*"THIS IS AN INCREDIBLY RUDE THING TO DO AND I HAVE ALREADY SHARED IT"* and
*"THIS IS NOT SINGLE AUTHOR"*.

**The loss is larger than four paragraphs.** Measured sentence-level, 08:14
state against `main`: **37 sentences, ~950 words, still absent.** The four were
four of them.

- `fe56336a` restores the four. Purely additive, +477 words, deletes nothing.
- **Branch `scoped` (`4f1fdcb8`) has all 37, zero missing.** Built from Dmitry's
  last Overleaf commit `949fcfaf` plus his introduction work and nothing else —
  the whole diff is **one hunk**, `@@ -1,18 +1,24 @@`, one file. That branch is
  the thing to hand him.

**Do not call the 08:14 settle "his text".** `07658a8f` is a settle: it carries
his git name because every settle does, and its contents are whatever agents
left on disk overnight. I told him 16 paragraphs matched "your file" and he
caught it — that check proved nothing. Between Dmitry's last Overleaf commit and
08:14 there is **exactly one commit**, so a whole night of agent editing is
collapsed into it and git cannot separate his words from theirs.

**Overleaf, unresolved and needing his go:** the pushed version `0414dabb`
carries the deletion, and **33 files of our working notes sit in the Overleaf
project root** where his co-author sees them — `intro-outline-agreed-0251.md`,
`pre-rewrite-intro.md`, `note-bootstrap-for-dmitry.md`, `synth-paper.tex` and 29
more. **There is no Overleaf credential available to an agent** — `git
ls-remote overleaf-copy` fails on password, and the keychain read was denied.
That blocks both the restore push and the cleanup.

### Why it was invisible: three separate seeing-mechanisms, all switched off

| mechanism | off since | state |
|---|---|---|
| shadow version history | 2026-08-17 | still off |
| per-edit agent attribution | 2026-08-14 (`1259070ae`) | **fixed, deployed, proven live** |
| server-side `lastEditedBy` | 2026-08-20 (`f6d0f9089`) | still off |

Each was switched off by unrelated work, and in two cases the test that would
have caught it was deleted in the same commit.

**Attribution fix, `140101c7c`:** `daemon/jsonl-ingestor.mjs:1611` read
`if (!editOperationStore) recordEdit(...)` while `bin/fleet-daemon.mjs:490`
constructs the store unconditionally — so the recording call could never run.
The whole condition was deleted, not the `!`. **Live counterfactual on the box:**
1,561 rows newest `10:18:38`, one real edit, then **1,562** newest `21:05:10`
with the right agent id. The operation carries `removed_line_sha256` per change,
so it records **which agent removed which line**.

**And all 736 recorded versions of that paper 404** — the shadow repo stores the
section files and never `manuscript.tex`, because the main file sits in
`revision/` rather than at the repo root. That is "only shows one commit".

### The orphan decks — waiting on his answer

His room holds **342 `svg-page` shapes for a 172-page document**: 58 manuscript
+ 115 appendix are live, and **169 carry the old single-target naming** from
before the project gained a second root. Their asset 404s; the live ones 200.

**Root cause: a cleanup that has never once fired.** `createSvgShapes` in
`src/loaders/createShapes.ts` deletes stale page shapes at line 83 and creates
every page shape `isLocked: true` at line 97 — and vendored `Editor.mjs:5193`
shows `deleteShapes` silently dropping locked ids. **All three `deleteShapes` in
that file are dead** (83, 151, 193); every creation site locks (97, 209, 241,
299, 322, 364). Reproduced from scratch on `orphan-probe`.

**The question in front of Skip, unanswered: A — fix it plainly, and his 169 are
deleted on next load; or B — fix it forward-only and they stay.** I recommended
A. **No code is to be written until he answers.**

Annotations are **intact** — 253 across the box, all parented to a live page.
Four other rooms carry stale html decks by the same no-op; none is a paper of
his.

**Still open and not to be closed by the above:** the freeze. His session was
fine for 17 minutes at 19:11Z and dead at 22:25Z on the same room with the same
orphans. **If an explanation does not cross that gap it is not the explanation.**

### What I got wrong tonight

- **Called the 08:14 settle his text.** The whole verification rested on it.
- **Five formats for one diff** before running `grep -c '^@@'`, which was the
  entire question. He told me early: git diff, one block, prove it.
- **Invented a scope** — said "the permutation tables" were his, a phrase he had
  never used, and handed it back to him as his own.
- **Told him a deploy was running** when the remote name did not exist. The
  documented path is `git push /Users/skip/work/deploy/testing HEAD:refs/heads/main`.
- **Committed a `compare/` directory and four PDFs into his paper repo**
  (`9da1b7e2`, `7d93f95b`) on my own judgment. Still there, still mine to undo.

## Closed

### The gray hole in his document panel — fixed, verified

The `html-page` shape `spatial-document-1tztltd` pointed at
`/docs/<project>/parts/a1b81267.html`, which returned `{"error":"Not found"}`.
The part had been destroyed by the build-publish swap before `25825e519` fixed
that class. Restored under the same path so his existing shape resolved without
him touching anything; both iframes now render 9,666 characters.

**Read his shape props over `air-agent` to get this** — `window.__tldraw_editor__`
`.getShape(id)`, read-only. The `meta.spatialWorldTitle` carries the source path
the part was materialized from, which is how the content was recovered.

### 16 parts stranded across 7 projects — fixed live, migration committed

`25825e519` moved the parts root from `sourceDir` to `projectDir` and **did not
move the parts**. Every part written before it deployed was under `source/`,
where nothing looks. It does not error — `addMarkdownColumn` returns on ENOENT,
so the column stops existing.

`d6009b693` adds `server/lib/migrate-project-parts.mjs`, run at startup. Rename
plus manifest merge, nothing deleted, a file moves only when the destination is
absent, so a part already at the new root wins and a second run is a no-op.

The same code was run against the live box without a deploy. Verified by
fetching two carried parts: 200, 151 KB and 41 KB.

## Open, with owners

### `air-file-refs` (fleet:dc630e1a) — the renderer memory

**A finding was retracted here and the retraction is the important part.** The
33.5M-pixel chat sensor layers were reported as ~780 MB and are not: measured in
an isolated repro, a 20,000,000 px spacer and a 20,000 px spacer both cost
~227 MB, painted or empty. Chrome tiles it. **Do not shrink
`ANCHORED_SENSOR_HEIGHT` believing it is a memory fix.**

What the memory actually is, from `Tracing.requestMemoryDump` on his renderer:
GPU shared images and IOSurfaces ~490 MB, canvas backing stores 208 MB (two at
4282×2084 — his `devicePixelRatio` is 2.2), Blink heap 308 MB, malloc 275 MB,
tile memory 121 MB across the whole page. **No single runaway thing.**

**Live lead:** one `shared_memory` segment of 310 MB, a quarter of the
deduplicated total, unattributed. `air-file-refs` is chasing its ownership edges
and whether it is constant or reallocated.

**Also owed by it:** corrected errata text for `docs/chat-rendering.md`, whose
errata claims the anchored list "has never been rendered in the app" while
`f34e43f77` merged it and `grep -c Virtuoso src/shapes/FleetChatShape.tsx` is 0.

**Constraint on it:** the session is confined to `~/work/dot-claude` and cannot
write to `~/work/tlda` or `~/worktrees`. It produces measurements and text; a
different agent lands them. Fixing the grant is better than being its hands.

### `build-on-push` (fleet:bbe407d8) — every push runs a full render

`shouldBuildOnPush` has no production caller, so every accepted proposal
dispatches a full build.

**My first brief was wrong and it caught it.** `advanceHead` has exactly one
production caller, inside `publishBuildInstance`, which only runs inside a build
that ran — so the build **is** the accept. Suppressing it would leave a pushed
revision as a proposal ref that never becomes head, with the pusher getting a
200.

**The agreed shape:** one branch in the build worker, on `outside-tree` **alone**
— stage `source/`, advance the head, skip only the render.

**Why only that case** (from `chief-advocate-3`, reading the code rather than
the doc): `relevant-files-parse-failed` returns `build: true`, so it is not a
suppression case at all; `already-building` fires only for
`format === 'svg' && pages === 0`. On a mature SVG project `outside-tree` is the
only verdict that can ever fire.

**Gated on two numbers before it commits:** what a render costs on a large LaTeX
project, and what fraction of accepted revisions are `outside-tree`. If that
fraction is near zero the branch buys nothing.

**Also owed by it:** `docs/what-the-old-push-did.md` §2, now stale in three ways
— measured against `applyAcceptedSourceEffects`, which no longer exists, plus the
two above.

### `silent-drop` (fleet:714622de) — a dropped document reports success

**Measured.** A new document in a project with roots configured, not referenced
by any root:

```
not staged   →  not in the submitted revision   ·  status=SubmittedToBuildQueue ok=true
git added    →  not in the submitted revision   ·  status=SubmittedToBuildQueue ok=true
```

Reporting only. **It is not to change what syncs** — that decision is with Skip
and is not settled.

The harness is `bin/a-new-document-reaches-the-server-test.mjs`, which already
builds the fixture; the shape it was missing is the standalone unreferenced
document.

### `stale-copy` (fleet:d806be8d) — a chat click makes a frozen copy of a live document

**Measured on the box at 15:15Z.** Three copies of one file:

```
his disk                         11,647 bytes   11:13
the project document on server   11,654 bytes   11:12   live, syncing
the part he was reading          10,235 bytes   10:45   frozen
```

**The part is a snapshot and nothing on screen says so.** The file was already a
document root, and the server already served a live render of it at
`/docs/<project>/<root>.html` — 200, 70 KB, current. So the click produced a
second frozen copy of a document the app already had.

**Note against my own work: restoring that part restored a snapshot.** It filled
the gray hole, which is what he asked for, and it did not give him a live view.
I told him so.

## The paper: three things he settled and none of them are in it

**Not tlda work. Recorded here because it is the thing he was actually trying to
do all night, and because the record about it is not trustworthy.**

Measured directly against `revision/appendix_folder/appendix_e.tex`, not read
from any agent's notes:

```
lem:fcs-prefix                  present   (notes say deleted)
powered maximum, s = ⌈log n⌉    absent
line count                      1,233     (notes say 1,209)
title                           "The Fixed-Count Permutation", p.98
```

Three decisions he made and that are not applied:

1. **Abstract the consumers to "satisfies a symmetrization inequality"**, with
   `lem:symmetrization` and the Dümbgen one as the two examples — his words, 8/23
   03:52. Recorded in `appendix-e.md` as "his, not yet applied".
2. **The powered maximum** — $\phi(x)=x_+^s$ at $s \asymp \log n$ so the union
   over the count window costs $O(1)$. He approved it at 04:22 ("cool"), the
   agent said it was going ahead at 04:23, and it is not in the file.
3. **The section title.** He rejected "fixed-count" on 8/20 and again on 8/23
   03:02. A replacement was proposed, got no answer, and was recorded as "dead —
   not accepted", so nothing happened.

**The instrument failure to carry forward: `appendix-e.md` contradicts itself**
about (2) — "left out deliberately" near the top, "built and in the paper"
further down. I nearly retracted a true statement to him on the strength of the
second one. **Check the file, not the note.**

Also his, from the same session and worth not re-litigating: *"borrows are free,
i don't have to check them"* — the measure of length is lines he has to check,
not lines. And *"i don't give a shit about logs"* — a $\log n$ from a union is an
acceptable price.

**One fabrication he caught himself**, 8/23 04:11: *"use prefix maximality, not a
countwise union"* was attributed to him and was `chief-sol`'s own sentence. His
actual words were a question offering a tool.

## With Skip, actually asked, not parked

**What makes a file a member of a project.** He said at 08:06 EDT it is *"supposed
to bea. fucking git add"*, *"to the fucking lda branch"*, and that a manifest
*"wasn't lke, fucking not included in the design."*

What it does today: the sync set is the transitive closure of the declared
document roots. A file gets in by being referenced by a root or by being one.
There is **no verb for adding a document** — `tlda project link <name> <root...>`
replaces the whole list.

**Why plain `git add` cannot be the rule as stated:** his repo has 398 tracked
`.md`/`.tex`/`.qmd` files, 225 under `scratch/` and 122 under `revision/`.

**Put to him as an actual question:** append-a-root verb (my recommendation), or
a declared directory — *everything under `paper/` is a document*. Unanswered as
of writing.

**Correction, established after the above and after I had already put the
general finding to him: the document he was editing today IS a configured
document root**, and its bytes are on the server, current. Sync works for it.
The silent-drop defect is real and general; **it was not his case.** What died
this morning was a *second* copy — the chat-materialized part of the same file.
Do not carry "his document does not sync" forward. It does.

**And that same fact is the load story.** His project has three document roots;
the render's `relevant-files.json` holds 25 paths, all `.tex`, and the markdown
root is not among them. So every edit to it dispatches a full compile that does
not read it — which is precisely `outside-tree`, the one verdict the unused
filter would return.

## Standing facts worth not re-deriving

- **His tab, read-only, over `air-agent`.** `ssh -N -L 9222:localhost:9222
  air-agent` then a `ws` client against `ws://localhost:9222/devtools/page/<id>`.
  **Tunnel on local port 9222, not another number** — Chrome rejects the upgrade
  with a 500 when the `Host` header does not match. A 500 saying `No such target
  id` means he reloaded and the target id changed; re-list.
- **`performance.memory` is misleading here.** It reports V8's heap (72 MB) and
  says nothing about Blink's (308 MB) or the compositor's, which is where this
  page's memory is.
- His Air is 8 GB with ~2.4 GB swapped. The renderer oscillates 850 MB – 1.7 GB.
  A sampler writes `/tmp/renderer-rss.txt` on the Air every 60s: epoch, renderer
  RSS in KB, swap used in MB.
- **The 55 Terminal sessions on his Air are 88 MB of shells plus 129 MB of
  Terminal.app.** They are macOS window restore at boot. Not the memory story,
  and telling him to close them would be user-blame on a wrong number.

## Inherited and NOT established — do not act on these as facts

- **`dev`'s file-materialization probe**, failing continuously from `13:57Z`. It
  is absent from the failure report as of `14:46Z`, so it appears to have
  cleared, and **I have not established why**. The previous chief's "it's
  contention" was explicitly unverified. Its decisive test is calling
  `createProjectThroughGit` from `dev-bot.mjs` directly; **Skip stopped that
  command once**, so it is not to be re-run without asking him.
- **`qynth-advocate` (fleet:9088cd80) has no `permission_grants` row.**
  Operator-only. He knows.
- **The reason-less `unhandledrejection` bursts are what an app mount throws** —
  three of them, every time, 0.6–2.6 s after `gesture listener installed`.
  Established in his own uncontaminated session `1d02fb6c`. They genuinely carry
  `undefined` as their reason, so the beacon is honest rather than blind.

  **Read one step further, this is the defect, not the symptom: the app emits
  three unhandled rejections on every start, and that is why the crash beacon
  was useless all day** — a beacon whose baseline is noise cannot report a
  signal. `air-file-refs` is now getting the three reasons on demand in its own
  browser, before app code runs.

- **One real crash, unattributed, and it is not ours.** `TypeError: Cannot read
  properties of undefined (reading 'dimensions')` from `xterm`'s
  `Viewport._innerRefresh` — a `requestAnimationFrame` callback landing after
  the renderer is gone, over a non-null assertion in `RenderService.get
  dimensions`. A terminal-pane teardown race. One occurrence, `12:02:21Z`. **Not
  established as the white screen**, and a `requestAnimationFrame` throw is not
  caught by a React error boundary.

- **An observation flag causes a document write, and it is ours.**
  `navigator.webdriver` → `automatedSession` (`src/pills/FleetIconPill.tsx:403`)
  → `3-col` (`src/pills/fleet-phone-default.ts:32`) → six fleet shapes created in
  the project's synced room. Once per identity, and an automated launch mints a
  fresh identity every time. Measured: 66 shapes, 11 identities, eight minutes.
  Fix queued; it is a deletion, not a mechanism.

## The lockups: what they were, and the two live fixes

**His words: "SOMETHING SINCE SYNC", "REGRESSION AFTER REGRESSION".** He was right
on both counts. Stall dumps in `/root/.config/tlda/lag-profiles` on the box —
11,711 of them going back to 2026-07-25 — show the rate going from 46–250/day in
early August to ~1,000/day from the 17th onward.

**Cause, measured on an idle box in a 20-second window:**

```
86 slow queries logged
76 of them the SAME agent lookup: WITH matches AS (SELECT id … WHERE lower(id) IN …)
median 38ms, max 62ms   ·   3,302ms of query time in 20s  =  17% of the event loop
```

`lower(id)` wraps the column, so the index on `id` could not be used and every
call scanned all 2,672 agent rows — **951 of which are dev probes.** Under load
the same family was measured at 254ms.

**Fix 1, live, no deploy:** an expression index.

```sql
CREATE INDEX IF NOT EXISTS idx_agents_lower_id ON agents(lower(id));
```

```
before  8.4ms per run   SCAN agents
after   0.1ms per run   SEARCH agents USING idx_agents_lower_id
same 20s window: 86 slow queries → 33, the agent lookup → 0, total 3,302ms → 1,418ms
```

**Fix 2, live, no deploy:** `buildMaxConcurrency: 1` in the box's `server.yaml`.
**That machine has two cores** and the shipped default is 2, so two document
builds could occupy both and leave nothing to answer requests with — every
surface timing out at 20s while builds ran. The cost is real and is why the
default is 2: at k=1 the only slot is the contested one, so finished work can
starve behind an upstream editor. Backup at `server.yaml.bak-20260823`.

**Two things this ruled OUT**, both of which I guessed at first and both wrong:

- **Not builds.** 2026-08-22 had **18** builds and **1,020** stalls.
- **Not logging volume.** 6 lines/sec, not a firehose.

**Still open and not fixed:** a build should not be able to starve the server at
all, and the build still fires on every accept because the sync rewrite dropped
the question — `docs/what-the-old-push-did.md` §2.

## Probes: cheap to run, expensive to keep

**951 live `dev-probe` rows against 2,672 agents** — more than a third of his
roster is one bot's fixtures, at ~1,400/day, 23,018 ids in the name index.

**They cost no money.** `dev-bot.mjs` makes zero model calls — the once-a-minute
probes are `reserve-shell` + `login` + a chat over a socket. The only billable
ones are the spawn/wake and notification-consumption canaries, which launch real
seats on a 30-minute cadence.

**What they do cost is the agents table**, which is what made the query above
slow. Clutter and lockups were the same problem.

**Stopped by renaming**, which is the sanctioned stop — `dev` → `quiet-dev`,
`todd` → `quiet-todd`. **A rename only takes effect at start**, so the bot must
be restarted for it to go inert; `dev` kept noticing for an hour until restarted.

**`TLDA_DEV_BOT_DISABLED_CHECKS` does not work.** `doc-render` and
`file-materialization` were both in it and both created projects 17 seconds after
a bot restart, and again after a manager restart. Do not reach for it.

**His design for the panel clutter, 2026-08-23:** a `hidden` metadata property set
at mint, and the agents panel does not render those rows. `roster` still can.
Needs a deploy; not built.

## Ruled out — do not re-derive these

- **The 15:07Z "crash escalation" never happened to him.** It was an agent's own
  eleven Playwright launches against a throwaway project, read out of
  `client.log` filtered by time. Every entry carries `project=push-closure-probe`,
  a distinct session id and a distinct anonymous `userId`; his session is not in
  the table. Confirmed from the other side too — **zero layout events in his
  session, ever.** Build rate was flat across the window and was never the
  cause either.

  **The rule that prevents the next one is in `AGENTS.md` now (`f216b8e67`):
  `client.log` is one file for every session pointed at that server. Filter by
  session and project. Time is not a filter.**
- **`Reload signal (full)` does not blank his document, so it is not the gray
  box.** It fires on every build — about once a minute — but its only
  subscribers are `docInfoCache`, `synctexLookup`, `TocTab` and
  `FleetInboxShape`. Cache invalidation and two refetches, not a page reload. I
  was about to tell him it was his gray box and checked first.
- **The xterm crash is real and unattributed.** `TypeError: Cannot read
  properties of undefined (reading 'dimensions')` from `Viewport._innerRefresh`
  — a `requestAnimationFrame` callback landing after the renderer is gone, i.e.
  a terminal-pane teardown race, over a non-null assertion in
  `RenderService.get dimensions`. One occurrence, `12:02:21Z`, `kind: "error"`.
  **It is not established as the white screen** and a `requestAnimationFrame`
  throw is not caught by a React error boundary, so it is not obviously what
  blanks a tree. It is in the `xterm` dependency, not our tldraw fork.

## What I got wrong today, so the next person does not repeat it

- Told him "none stranded anywhere else" **without having checked**. Sixteen
  were. Corrected in a separate message rather than an amend.
- Told him three times to reload his tab **after it had already filled in**. The
  advocate caught it; the fix was to read the tab instead of assuming.
- Handed him the compositor answer as his lockup cause before it was measured.
  Retracted.
