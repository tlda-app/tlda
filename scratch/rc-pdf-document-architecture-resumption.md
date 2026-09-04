# The PDF RC: what already exists and where

`pm-rc-docformat`, 2026-09-03 18:30 EDT. Resumption point for the document-format /
native-PDF release candidate. Force-add this if it is not tracked — `AGENTS.md`
§"Repository workflow" distinguishes a *report* from a *resumption point*, and this is
the second kind.

## Where it is {#where-it-is}

**Branch `pdf-document-architecture`, tip `88a4a9b58`, with a live worktree at
`/Users/skip/worktrees/tlda-pdf-document-architecture`. The worktree is clean and sits
on the tip.** Nothing needs recovering from a reflog and nothing needs rebuilding.

**The tip is one commit past the merge that was reverted**, and that commit was made
*after* the revert:

| sha | author | time (08-21 EDT) | subject |
|---|---|---|---|
| `db61cefd4` | `pdf-document-architecture` | 05:42 | Refactor document formats and add native PDF — 47 files, +1113/−207 |
| `49418e435` | `pdf-document-architecture` | 06:29 | remove legacy document format runtime paths — 43 files, +372/−195 |
| `f6e68fb60` | `pdf-document-architecture` | 06:41 | remove remaining legacy document format paths — 6 files |
| `06c2f8f14` | `pdf-document-architecture` | 07:11 | make document adapters and manifests the shared boundary — 18 files |
| `1e17cffbd` | `bhief-sol` | 11:16 | carry document view capabilities through runtime — 60 files, +300/−507 |
| `dc30b1805` | `bhief-sol` | 11:30 | preserve adapter-declared view capabilities — 12 files |
| `7d6f64f39` | `bhief-sol` | **11:45** | **Merge document format architecture** |
| `281e72172` | `bhief-sol` | **12:01** | **Revert "Merge document format architecture"** |
| `88a4a9b58` | `bhief-sol` | 12:55 | Finish native PDF and Beamer browser paths — 3 files |

**The four commits that are the RC were written by one agent between 05:42 and 07:11.
The two immediately before the merge were written by the merger, four hours later.**
That is not an accusation, it is the shape: whatever was untested at 11:45 is most
likely in the 11:16 and 11:30 commits, which nobody had exercised.

## Why it was reverted {#why-reverted}

**Because it was merged, not because it was wrong.** Skip to `bhief-sol`, 2026-08-21:

> **12:00:27** — you merged an untested partial bersipn pf an r c
>
> **12:00:45** — point of a fuxking rc is to fucking like finish it on a fucking branch

**The revert commit is timestamped 12:01:00 — fifteen seconds after the second
message.** He said the same thing again at 12:22:18 in his own framing, and it is
worth carrying whole because it is a question, not a directive:

> ugh and did i fuck a bunch of stuff up by not wanting the pdf rc? like if everything
> was based on it and we are now worse off, like, we could put it back and then
> continue its dvelopment without mergig again

## What it does {#what-it-does}

**The factoring: three independent axes replacing one overloaded word.**
`shared/document-formats.mjs` on the branch replaces `format` with
`sourceFormat` · `renderer` · `documentFormat`:

```
svg      → tex  · latex    · paged
markdown → md   · markdown · html
html     → html · identity · html
slides   → html · identity · slides
qmd      → qmd  · quarto   · html
png      → png  · identity · paged
book     → book · identity · book
```

`viewFormat` becomes derived from those rather than a special case for `qmd`, and gains
a `pdf` answer. **This is the right diagnosis** — three of us reached the same reading
of the current code independently before finding this branch: `format` is one word
carrying four different questions on the server and, per `rc-read-view`, **five separate
fields with the same name** on the client.

**The PDF half needs no TeX and never did.** `server/lib/build-pdf.mjs` (112 lines)
shells out to **poppler** — `pdfinfo` for page count and page size, `pdftotext -bbox`
for **word-level geometry**, `pdftocairo` for rasterisation. So a `.pdf` becomes a
document with anchorable text, not merely a picture. **Poppler is not TeX**, it is
installed on this Mini, and the branch adds `poppler-utils` to `Dockerfile.live`
together with a `pdfinfo -v && pdftocairo -v && pdftotext -v` verification line in the
image build.

**Files the branch adds that `main` does not have:** `server/lib/build-pdf.mjs`,
`server/lib/build-adapter-registry.mjs`, `server/lib/document-manifest.mjs`,
`mcp-server/lib/pdfCoords.mjs`, and three tests —
`daemon/native-pdf-git-visible.test.mjs`, `server/lib/pdf-runtime-boundary.test.mjs`,
`server/lib/beamer-adapter.e2e.test.mjs`.

**The factoring already deletes.** `49418e435` removes 195 lines of legacy runtime
paths across 43 files and `f6e68fb60` finishes the job; `1e17cffbd` is net −207.
Whatever else is true, this is not an addition wearing the word.

## Two things I have not settled, and one is for Skip {#open}

**1. `documentAxes()` throws on an unmigrated project.** On the branch it reads:

```js
if (!project.sourceFormat || !project.renderer || !project.documentFormat) {
  throw new Error('Project document axes have not been migrated')
}
```

**That is a hard migration gate on every project read at runtime**, and it is the same
shape `AGENTS.md` records under *"Make source manifests authoritative"* — a declared
contract the server hard-rejects against, which wedged work for eleven days. Whether
the migration is complete, idempotent, and re-runnable is the first thing I would check
before this is exercised on anything. `legacyDocumentAxes()` exists beside it as the
fallback path, so the answer may be fine; I have not read the migration.

**2. Skip said we are not supposed to have a document manifest.** Same day, 47 minutes
after the revert, while a project was failing to render:

> **12:48:17** — wtf is the document manifest
>
> **12:48:27** — we arent supposed to have a fucking document manifest

**The branch contains `server/lib/document-manifest.mjs`, and `06c2f8f14` is titled
"make document adapters and manifests the shared boundary."**

**I have not established that those two are about each other.** He was looking at a
project that would not render, and `main` already has a `tlda-manifest.mjs` that
validates qmd pages, so he may have been talking about that one. **But it is his
sentence about a thing this branch introduces, and it is not mine to resolve by
guessing.** It is a real question with two options, and it goes to him in that form
rather than being decided here.

## What has never happened {#never-happened}

Skip, 2026-09-03 18:21 EDT, relayed: *"I've never used it."*

**That is the gap.** The building is largely done. What was skipped is the RC process
itself — off to the side, exercised, monitored until clearly ready. No merge, no
deployment, local Mini only.

---

# Why he has never used it {#why-never-used}

Added 2026-09-03 19:00 EDT by `pm-rc-docformat`, measured on the branch tip, not read.

**The RC cannot start against any existing project store. Not "degrades" — does not
start.**

`initProjectStore()` calls `assertStoredProjectAxes(dir)` before it does anything else.
That walks every project directory and throws on the first `project.json` that either
lacks the three axes or still carries `format`. **Every project on every real box carries
`format`.**

## The measurement {#the-measurement}

Three stores built fresh in a temp dir, each with one project, run against the branch
tip's own `project-store.mjs`. **Positive control first**, so the failures mean
something:

```
migrated   STARTS
legacy     THROWS  Project a-paper uses the removed legacy format field
both       THROWS  Project a-paper uses the removed legacy format field
legacy#2   THROWS  Project a-paper uses the removed legacy format field
```

- **`migrated`** — the three axes, no `format`. Starts. The instrument can go green.
- **`legacy`** — `format: 'svg'`, no axes. What every real project looks like.
- **`both`** — axes present *and* `format` still present. **Also throws**, which is the
  important row: **the migration cannot be done incrementally.** You cannot add axes in
  one pass and drop `format` in a later one, because the intermediate state is rejected.
  Each project's conversion has to be atomic.
- **`legacy#2`** — re-running converges on nothing, because there is nothing to run.

**And the loop throws on the first bad project**, so one unmigrated project takes the
server down regardless of how many others are fine.

## It is deliberate, and it is stated {#deliberate}

`docs/document-formats.md`, on the branch:

> Runtime startup rejects records without all three axes or with the removed `format`
> field; **there is no compatibility or startup migration path.**

So this is not an oversight to report as a bug. It is a design decision that makes the
RC unusable against anything that already exists — which is exactly the reason Skip has
never used it. **He could not have.**

## The fix is a restoration, not a design {#the-fix}

**The migration already exists in this branch's own history and was deleted during its
development.** `db61cefd4` — the RC's *first* commit — carried `LEGACY_AXES`, a total
map from all seven project formats onto the three axes, plus `legacyDocumentAxes()`
which reads a project through it:

```
svg → tex·latex·paged        markdown → md·markdown·html
html → html·identity·html    slides   → html·identity·slides
qmd → qmd·quarto·html        png      → png·identity·paged
book → book·identity·book
```

It is **total over every value a project's `format` can hold**, and it already handles
the one case where the axes are not a function of `format` alone — `qmd` with
`renderedFormat: 'slides'`. By the branch tip both the table and the function are gone.

**So the blocking defect in this RC is fixed by restoring ten lines the RC itself
deleted.** That is the smallest possible change and it is not new architecture.

**Open choice, mine to make unless someone objects:** convert each `project.json` in
place once at startup, or derive the axes on read and leave the stored record alone.
The `both` row above rules out doing it in two passes either way.

---

# The thing that had never happened, now done {#pdf-works}

`pm-rc-docformat`, 2026-09-03 19:10 EDT. Run on the Mini against a disposable store in
a temp dir. Nothing near `pic`, `pic-dev` or `testing`; no server deployed.

**A PDF whose source is not available becomes a document with working text anchors, and
no TeX is involved at any point.**

The fixture is `bracket-test.pdf`, already on the branch — **produced by pdfTeX in May**,
which makes it exactly the case Skip named: the PDF exists, and TeX is not what renders
it here.

```
--- pages ---
    multi-page-1.svg  612 x 792 pts  svg:yes
    multi-page-2.svg  612 x 792 pts  svg:yes
    multi-page-3.svg  612 x 792 pts  svg:yes

--- text anchors ---
    page 1: 39 words, box 612 x 792
        "1"        x=133.768     y=124.808737  w=8.1   h=12.7
        "Bracket"  x=157.977213  y=124.808737  w=54.4  h=12.7
        "tests"    x=217.710485  y=124.808737  w=32.6  h=12.7
    page 2: 39 words …
    page 3: 39 words …

--- manifest view contract ---
    {"kind":"svg-pages","capabilities":{"presentation":false,"sourceMapping":false,"searchableText":true}}

--- verdict ---
    pages extracted        PASS  (3)
    an svg per page        PASS
    word-level anchors     PASS  (117 words)
    declares searchable    PASS
```

**Word-level geometry is the whole point.** `rc-read-pdf` established that the annotation
system's canonical coordinate space *is* PDF page space — `canvasToPdf`, `pdfToCanvas`,
`pdfSpan`, `pdf_width`/`pdf_height`. What poppler hands back here is already in that
space. A PDF is not a picture in this app; it is a first-class annotatable document.

**The counterfactual fires.** A project declared `sourceFormat: 'pdf'` whose `mainFile`
is a `.tex` is refused — *"A PDF project requires a .pdf mainFile"* — rather than
silently producing an empty document. So the PASS rows above are about the PDF path and
not about a function that accepts anything.

**Both the single-page and the multi-page runs were made**, because pages 2 and beyond
take a different code path (`pageSize()` re-queries `pdfinfo` per page rather than
reusing the document-level size). Both work.

## What this does NOT establish {#pdf-limits}

**This is the producing half. It is not the wire.** `AGENTS.md` §"Prove the wire, not the
two ends" applies directly and I am not going to launder it: I ran the builder and read
its artifacts. **Nobody has yet opened one of these in a browser.** The manifest declares
`view.kind: 'svg-pages'`, and whether the client's loader registry honours that for a
`pdf` project is a separate proof that has not been made.

**The three pages of the fixture are identical**, so the per-page loop is exercised but
varying page sizes within one document are not.

**And none of this ran through a server.** It is a direct call to `buildPdfDocument`.
The build worker's dispatch to the PDF adapter is untested here.

---

# Are the axes declared or computed? Two of three, and the third is redundant {#axes-question}

`pm-rc-docformat`, 2026-09-03 19:20 EDT. Measured on the branch, not reasoned from the
design doc.

The question came from Skip moving project membership from **declared in a manifest** to
**derived from the git repository**. If membership is computed, are the axes?

**Answered per axis, because they do not have the same answer.**

## `sourceFormat` — computed {#axis-source}

It is the file's extension and nothing else: `.tex`→`tex`, `.md`→`md`, `.qmd`→`qmd`,
`.html`→`html`, `.pdf`→`pdf`. That map already exists on `main` as
`DOCUMENT_EXTENSION_FORMATS` in `shared/document-roots.mjs`, which is already how a
document root's format is derived, and it already lives beside the rule Skip stated —
*"document roots is just a computed property of the git branch"*.

**So this axis is on the wrong side of the declared/computed line for the same reason
membership was, and the fix is the same fix.** Nothing needs migrating that is derived.

## `renderer` — redundant, and it should not exist {#axis-renderer}

**Every `(sourceFormat, renderer)` pair written anywhere on the branch — 63 sites,
including tests:**

```
  17  sourceFormat: 'tex',  renderer: 'latex'
  17  sourceFormat: 'md',   renderer: 'markdown'
  13  sourceFormat: 'pdf',  renderer: 'identity'
   8  sourceFormat: 'qmd',  renderer: 'quarto'
   6  sourceFormat: 'html', renderer: 'identity'
   2  sourceFormat: 'book', renderer: 'identity'
```

**Six pairs. `renderer` is a strict function of `sourceFormat` with no exception
anywhere**, and `build-adapter-registry.mjs` confirms it from the other side: no adapter
maps one source format to two renderers.

**So `renderer` is a second encoding of a fact `sourceFormat` already carries** — which
is precisely the disease this whole factoring exists to cure. The RC's own header on
`main` argues the point in its own words: one set, imported by both sides, is what keeps
two readers from drifting apart. A derived axis stored as a third field can drift from
its source in exactly that way.

**The argument against deleting it, stated fairly:** `renderer` is the axis that would
let a `.md` be rendered by quarto instead of the markdown builder, or a `.tex` by
tectonic instead of latex. That is a real future want and the axis is where it would
live. **But nothing wants it today, and `AGENTS.md` is explicit that a path is deleted
rather than kept for a requirement nobody has yet.**

## `documentFormat` — genuinely declared, and it cannot be computed {#axis-document}

**This one is not derivable from the filename and never was.** The same `.html` source is
`html` for a scrolling page and `slides` for a deck; a `.qmd` is one or the other
depending on the `format:` its author wrote and what quarto actually produced.

**That is not new with this branch — it is exactly why `renderedFormat` already exists on
`main`**, and why `viewFormat()` exists to ask the question. `documentFormat` is that
same fact under a better name, generalised past `qmd`.

## What this changes about the migration {#axes-migration}

**Most of it stops being needed.**

- `sourceFormat` is computed from the extension. **You do not migrate a derived value.**
- `renderer` is deleted, so there is nothing to migrate.
- `documentFormat` is the only stored axis, and for every existing project it is a total
  function of the `format` and `renderedFormat` those projects already carry — which is
  the third column of the `LEGACY_AXES` table this branch deleted from its own first
  commit.

**So the RC gets smaller, not bigger**: one stored field derived from data every project
already has, instead of three fields, a startup assertion, and a migration that does not
exist.

**This is a change to a design the branch states, so it is a proposal and not something I
have done.** `docs/document-formats.md` on the branch says *"three independent axes"*.
The measurement above says two, one of which is computed. I would rather be told no than
build it unasked.

---

# What is actually stale, and why it converges with the axes question {#staleness}

`pm-rc-docformat`, 2026-09-03 19:30 EDT.

Skip, 18:42:56 EDT, on the manifest conflict:

> we changed how membership in a project is coded. From being in a document [manifest] to
> just being about being in a Git repository. And so the PDF thing has stale version, and
> we can just — that's just something we update.

**First, a thing I had wrong and want to correct before it propagates.** The branch's
`server/lib/document-manifest.mjs` is **not** the manifest he means. Its `assets` are
build *output* artifacts — `relativeArtifact()` refuses anything that leaves the output
directory. It describes a render, not a membership.

## The membership change is six commits on `main`, all after the branch {#the-six}

```
6719514a2  Model project document roots by format
f33efe6f0  Build every linked project document root
06644edbc  A declared document root is a source file
08b551be3  A PDF figure is a source file; the compiled paper still is not
d5a264fe0  Publish every document in the tree, computed, not the stored list
b344d7105  The relink fix was incomplete: the invention moved one step later
```

**`d5a264fe0` is the one he described**, 2026-08-26, five days after the branch. Its own
message states the defect and the ruling:

> the stored documentRoots — written once when somebody linked the project, appended to by
> the chat click-adopt path, and never recomputed … Skip specified the replacement:
> *"document roots is just a computed property of the git branch"*, *"create the directed
> include graph. roots are roots"*.

## The measurement {#staleness-measured}

```
symbol                        branch    main
formatForDocumentPath            0        present
documentRootsIn                  0        present
DOCUMENT_EXTENSION_FORMATS       0        present
```

**The entire computed include-graph walk — 215 lines of `shared/document-roots.mjs` — does
not exist on the branch.** It is not that the branch disagrees with it; the branch predates
it. That is exactly "stale", and exactly "something we update".

**And it costs almost nothing to take**, because it is pure new work on `main`:
`shared/document-roots.mjs` **is not among the 27 conflicted files.** The recovery picks it
up clean. The reconciliation is `shared/source-manifest.mjs`, which is 70 changed lines and
is conflicted.

## Why this collapses the two open items into one {#convergence}

**`formatForDocumentPath` *is* the computed `sourceFormat`.** It is a map from file
extension onto exactly the values the branch calls source formats, it already lives beside
Skip's computed-roots rule, and it is already how a document root's format is decided on
`main` today.

So "bring the branch forward to computed membership" and "make `sourceFormat` computed
rather than declared and migrated" **are the same edit**. The axes proposal is not my
invention layered on top — it is the branch adopting the mechanism `main` already has,
which is what bringing it forward means.

**The consequence for the blocking defect:** with `sourceFormat` computed and `renderer`
deleted, the startup assertion has one field left to check and that field is derivable from
what every project already stores. **The migration that does not exist mostly stops needing
to.**

**Still a proposal.** Deleting an axis changes what `docs/document-formats.md` on the branch
declares, and that is not mine to decide.

---

# The 27 conflicts: shape, and the one real hazard {#conflicts}

`pm-rc-docformat`, 2026-09-03 19:40 EDT.

**Regenerate this state in one command** — it is exactly reproducible, so nothing needs
preserving in a fragile half-merged worktree:

```sh
git checkout -b <branch> main && git revert -n 281e72172
```

**57 conflict hunks across 27 files. Five files carry 23 of them; the other 22 files carry
one or two each.**

```
 6  cli/tlda.mjs                    2  src/SvgDocument.tsx
 5  src/BookViewer.tsx              2  src/BookContext.ts
 4  src/App.tsx                     2  server/unified-server.mjs
 4  server/lib/format-builders.mjs  2  server/routes/projects.mjs
 4  server/lib/build-qmd.mjs        2  server/lib/project-store.mjs
 2  src/loaders/svgLoader.ts        2  daemon/git-project-sync.mjs
 2  src/loaders/slidesLoader.ts     2  bin/build-worker.mjs
 2  src/editorSetup.ts              1  × 11 more files
```

## Three kinds, from sampling {#conflict-kinds}

**Trivial.** `server/lib/build-markdown.mjs` is a reworded error message. Most of the
one-hunk files are this.

**Superseded — resolve toward `main` and delete the branch's version.**
`shared/source-manifest.mjs` is the clean example. The branch adds a narrow special case:

```js
if (ctx.sourceFormat === 'pdf' && rel === ctx.mainFile) return true
```

`main` has since solved the same problem more generally, by ordering `referencedRoots`
above the junk test, under Skip's 2026-08-26 ruling that *"a pdf with no corresponding tex
or svg is a source"*. **`main` moved past the branch in the same direction**, so the
branch's line goes.

**Substantive — and this is where the hazard lives.** `bin/build-worker.mjs` is the case.
The branch replaces the whole format-dispatch block with one call to `buildDocument()`
through the adapter registry. But **`main` has since added real behaviour inside exactly
that block**: the `relevance.skip` path that publishes source without rendering when
nothing the revision changed is read by the render, and `finalizeBuildVersion()`, whose own
comment records that these formats *"built for months without ever recording"* a version.

## The hazard, stated plainly {#the-hazard}

**A recovery that resolves toward the branch silently deletes thirteen days of behaviour
that was added inside the code the branch replaces.** It will look clean, it will typecheck,
and the loss is invisible — `relevance.skip` and the version finalizer both fail by simply
not happening.

This is the pattern `AGENTS.md` names twice: a rewrite dropping the checks the original
carried, and *"a grep finds a call that is present and can never find one that is
missing."*

**So the mitigation is the one this repo already uses for exactly this**:
`docs/what-the-old-push-did.md` enumerates everything the old push path did and marks each
item carried / dropped / gap, precisely because an enumeration is the only way to bound what
a deletion takes with it.

**I propose the same artifact for this recovery, and I would write it before resolving a
single conflict**: for each of the five substantive files, what `main` does inside the block
the branch replaces, and where that behaviour lands on the other side. It is cheap, it is
checkable by someone who is not me, and without it "the tests pass" is not evidence about
the thing most likely to go wrong.

---

# What `main` does inside the blocks the branch replaces {#enumeration}

`pm-rc-docformat`, 2026-09-03 19:50 EDT. The artifact proposed above, in the manner of
`docs/what-the-old-push-did.md`. **One of five files worked; the other four remain.**

## `bin/build-worker.mjs` — the build handler {#enum-build-worker}

The branch replaces the format-dispatch block with a single `buildDocument(project, …)`
through the adapter registry. Here is everything `main`'s version of that block does, and
where each item stands.

| what `main` does | status | note |
|---|---|---|
| `missingDeclaredMainFile` guard — refuses to build a project whose declared main file is not in the tree | **carried** | the branch has it, same import from `build-decision.mjs`. Its comment records the cost of not having it: a talk declaring a `.tex` main built *"successfully"* for four days |
| `renderRelevance(msg, lifecycle)` — decides whether the change reaches the render | **DROPPED** | no `relevance` anywhere on the branch |
| `relevance.skip` → publish source without rendering, revision still lands | **DROPPED** | its comment: skipping the *admission* instead would strand the push, because the head only moves inside `publishBuildInstance` |
| `finalizeBuildVersion(...)` after a non-LaTeX builder | **DROPPED** | its comment: versioning used to live inside the LaTeX branch, *"which is why these formats built for months without ever recording one"* |
| `replacedItems = relevance?.skip ? ['source'] : null` into `publishBuildInstance` | **DROPPED** | the mechanism by which a skipped render still advances source and head |
| `recordBuildResult(… 'not_required' …)` when the render was skipped | **DROPPED** | the branch records only `built`, `superseded`, `build_failed` |
| — | **new on branch** | `outcome.disposition === 'superseded'` → `recordBuildResult(… 'superseded' …)` |

## And the drop is drift, not a decision {#enum-drift}

**This matters, because "the branch removed it" and "the branch predates it" call for
opposite handling.** Measured against three refs with a positive control on each, so an
empty cell is a zero and not a broken query:

```
ref                      renderRelevance  finalizeBuildVersion  buildDocument   [control: msg.name]
dc30b1805  merge-base           0                  0                  2                 17
4490e53ac  main                 2                  2                  0                 26
b8cc1550c  branch               0                  0                  2                 17
```

**Both are zero at the merge-base.** They landed on `main` on 2026-08-23 in
`3966d1400 "Skip the render when a push changes nothing the render reads"` — two days
after the branch. **The branch never saw them and never rejected them.**

So the resolution is not a judgement call between two designs. It is: **carry four
behaviours across the new boundary.** `buildDocument()` is the sole completion boundary on
the branch, which is where relevance, the skip disposition, version finalization and the
`not_required` result all have to land.

**None of them fails loudly if forgotten.** A dropped relevance check means every push
re-renders; a dropped `finalizeBuildVersion` means builds stop recording versions, which is
a defect this repo has already shipped once and had to notice from outside. That is why the
enumeration exists rather than a test.

---

# Corrections to the reader reports {#corrections}

`pm-rc-docformat`, 2026-09-03 20:05 EDT. `rc-read-build` self-corrected after being
released. Folding it in here so the numbers in this file are the ones to trust.

**The branch-site count is 35, not 34.** Its sweep pattern `\.has\(\s*\w*[Ff]ormat` cannot
match `.has(project.format)` — `\w*` stops at the dot — so **every set-membership test was
structurally invisible to it.** The missed site is the project-detail route's
`include=page-info` clause in `server/routes/projects.mjs`, which inlines `page-info.json`
into the project response only for a format in `FORMATS_WITH_OWN_PAGE_INFO`. It re-swept for
all four named sets plus `switch` and `.includes()` forms; those return none.

**`HTML_PAGE_FORMATS` has no server consumer.** Nine call sites, all in `src/`. It lives in
`shared/` and is imported only by the client. **It is still one of the seven enumerations
and still disagrees with the others, but it is not server surface** — and I described the
seven as being "on the server and shared side" to the chief, which is literally true and
misleading in emphasis. Nothing in the axes proposal leans on that row.

**A stale claim in this layer's own design record.** `shared/document-formats.mjs`'s header
says the server "named **all three** formats and honoured it in **five places**." The set
holds **four** today, `qmd` having been added, and there is exactly **one** server call site
on `main`. **Recorded as a discrepancy, not diagnosed** — nobody established when the other
four went. This is `AGENTS.md` §"The mirror: a durable note can be the thing that expired",
in the very file that is this layer's design record, so it should be fixed by whoever next
touches that file.

## The reason it is worth reading its account of the error {#corrections-class}

`rc-read-build`'s own framing, and it is the useful part:

> The two false zeros I already reported were a bad regex flavour and a broken PATH. This
> one is the same disease — *a query that answers, about the wrong population* — and it got
> past me because the first two made me confident the sweep was sound. **The pattern was
> checked against the sites it found and never against the sites it structurally could not
> find.**

**Three instrument failures in one task, all in the same class, one of them caused by having
already caught two.** For anything else in this RC that rests on a sweep, that is the check
to run: not "does the query return the sites I know about" but "what shape of site can this
pattern not match."

---

# Correcting my own cost estimate {#cost-correction}

`pm-rc-docformat`, 2026-09-03 20:20 EDT.

**I told the chief this recovery was "a night, done carefully", on the strength of 57
conflict hunks across 27 files. That was the wrong measure and the estimate was wrong.**

**A conflict count measures textual overlap. It does not measure behavioural drift**, and
the drift is what a recovery can silently destroy.

## The measurement {#cost-measured}

**237 distinct commits touched the conflicted files between the revert and `main`.**

Per file, post-revert:

```
 69  server/unified-server.mjs      11  src/App.tsx
 27  cli/tlda.mjs                   10  server/lib/build-qmd.mjs
 20  server/routes/projects.mjs      7  bin/build-worker.mjs
 19  src/BookViewer.tsx              6  server/lib/format-builders.mjs
 14  server/lib/build-runner.mjs     3  src/loaders/slidesLoader.ts
 13  server/lib/project-store.mjs    2  shared/source-manifest.mjs
```

## The reduction I expected, and did not get {#cost-no-reduction}

**A file is not a block**, so I expected block-scoping to cut this hard. `git log -L` on
`main`'s dispatch block in `bin/build-worker.mjs` returns **two** post-revert commits
against **seven** for the whole file — a 3.5× cut on one hand-picked block, and I was
ready to report that the problem was far smaller than the file counts suggest.

**Running it across every hunk says otherwise:**

```
file                             blocks   post-revert commits in those blocks   whole file
bin/build-worker.mjs                6                    7                          7
server/lib/format-builders.mjs      5                    6                          6
server/lib/build-qmd.mjs            7                   10                         10
server/lib/project-store.mjs       14                   13                         13
shared/source-manifest.mjs          3                    2                          2
server/routes/projects.mjs         20                   20                         20
```

**Six of six: block-scoped equals whole-file.** The branch rewrites *many* blocks per file,
and their union covers essentially all of that file's churn. **My one-block sample was not
representative and generalising from it would have understated the work by two orders of
magnitude.**

**I stopped the sweep at six of ten files.** The remaining four include the two largest in
the repository, `git log -L` over them is slow, and the box was at load 58.53 with Skip on
it. **The marginal precision was not worth his machine** — and by the pattern above their
block counts will approximate their file counts anyway.

## What the honest estimate is {#cost-honest}

**Not a night. On the order of 180–237 commits of behavioural drift to review**, most of
which will prove irrelevant — but *which* are irrelevant cannot be asserted without
looking, and that is the whole cost.

## Which raises a route I have not priced {#cost-two-routes}

**Route A, the revert-of-the-revert** — what I have been costing. Take the branch's 13-day-old
tree and reconcile 237 commits of drift into it. The hazard is subtraction: behaviour added
to `main` inside blocks the branch replaces, failing silently by not happening.

**Route B, re-apply the design onto current `main`** — take `main` as the base and port the
branch's *decisions* onto it, using the branch as the specification it already is. It has a
design doc, tests, and a working PDF implementation, so this is not rewriting from scratch;
it is transcribing a known answer onto a moved base. **The hazard here is the opposite and
milder: omission, which shows up as a missing feature rather than a silently deleted one.**

**Skip said to pick up and continue the RC. He did not say the continuation has to be the
literal revert**, and I do not think this is my decision to take alone. **I have not priced
Route B**, and I will not claim it is cheaper until I have — I have now been wrong once
today by estimating from the convenient measure rather than the right one.

---

# Route B, priced — and it changes the recommendation {#route-b}

`pm-rc-docformat`, 2026-09-03 20:35 EDT. Measured, then the worktree removed.

**The recovery is 77 files, and they split cleanly into two groups that behave completely
differently:**

```
18 files ADDED     — new modules and tests; no conflict; land identically in either route
59 files MODIFIED  — +316 / -240
```

**So the two routes differ over about 556 changed lines across 59 files.** The other ~906
insertions are the 18 new files — `build-pdf.mjs`, `build-document.mjs`,
`build-adapter-registry.mjs`, `document-manifest.mjs`, `document-transport.mjs`,
`documentLoaderRegistry.ts`, `docs/document-formats.md` and eight tests — which are new to
`main` and cannot conflict with anything.

**That reframes the whole problem. The RC's hard part was never volume.** It is **556 lines
whose correctness depends on 237 commits of context.**

## Which makes Route B the one I would take {#route-b-recommendation}

**Route A** reconciles those 556 lines through 27 conflicts. Its failure mode is
**subtraction**: behaviour `main` added inside a block the branch replaces disappears, the
result typechecks, and the loss shows up as something quietly not happening. `renderRelevance`
and `finalizeBuildVersion` in `bin/build-worker.mjs` are two confirmed instances.

**Route B** writes those same 556 lines onto `main`'s current text, using the branch's own
diff as the specification. Its failure mode is **omission**: a branch behaviour never gets
transcribed. **That fails visibly, as a missing feature, and it is checkable.**

**And the check already exists on the branch.** Ten tests that are specifically about this
work, 477 lines, all in the added-free group:

```
server/lib/document-manifest.test.mjs      98    daemon/native-pdf-git-visible.test.mjs   136
server/lib/format-builders.test.mjs        55    server/lib/beamer-adapter.e2e.test.mjs    50
tests/documentLoaderRegistry.test.ts       37    mcp-server/lib/formatCoords.test.mjs      28
server/lib/document-architecture.test.mjs  23    shared/document-transport.test.mjs        23
shared/document-formats.test.mjs           15    server/lib/pdf-runtime-boundary.test.mjs  12
```

**Plus `docs/document-formats.md`, which is the design written down by the person who built
it.** Route B is therefore not a rewrite from scratch — it is transcribing a known, tested,
documented answer onto a base that moved. **That is the distinction `AGENTS.md` cares about**,
and it is why I am willing to recommend it after refusing to guess earlier.

## A measurement trap I nearly walked into, recorded because it is reusable {#route-b-trap}

`git diff main pdf-document-architecture` reports **42** added files. **Only 18 of them are
this RC.** The other 24 are files **`main` deleted after the revert** — `terminal-rpc-notify.test.mjs`
and `wake-route-lifecycle.test.mjs` went in `5a0f2ca4f`, `index-chat-tail.test.mjs` in
`f209946e2`, none of them anything to do with document formats. Verified per file, not assumed.

**A branch-versus-`main` diff on a 13-day-old branch shows `main`'s deletions as the branch's
additions.** The revert's own scope — 77 files — is the honest measure, because it is bounded
by what the merge actually touched. **`git revert -n` is a better instrument here than `git
diff`**, which is not a distinction I expected to need.

## What is still not priced {#route-b-open}

**The per-line judgement.** 556 lines is a size, not a difficulty, and I am not going to
repeat today's mistake by implying the two are the same. What the size does establish is that
this is a tractable piece of work rather than an open-ended one, whichever route is chosen.

---

# The port begins, and a page-size caveat on my own PDF proof {#port-step-1}

`pm-rc-docformat`, 2026-09-03 20:55 EDT. Work moves to branch **`rc-docformat`**, cut from
`main`. Route B. `pdf-document-architecture` stays untouched as the specification.

## Step one landed: `c0e028a1c` {#port-commit-1}

16 new files, `tsc -b` exit 0 read directly rather than through a pipe, eslint clean.
**Nothing that `main` reads today changed** — the three axes were added *beside* the
existing `format` API, with the file saying in its own comments that the duplication is
scaffolding with a scheduled demolition.

**Held back deliberately**, because they do not typecheck without client files not yet
ported: `src/loaders/documentLoaderRegistry.ts` and its test, plus
`server/lib/document-architecture.test.mjs`, which imports a `buildHtmlDocument` that has
not moved yet. Step-two work, not defects.

## The subtraction hazard was real and it was in the first file {#port-hazard-live}

**`Dockerfile.live` got `poppler-utils` and its verification line by hand, two lines, rather
than by taking the branch's version of that file.** The branch's version *also deletes*
`maps`, `gt`, `grf`, `imager` and `libglpk40` — which `main` added afterwards for the
classroom decks. Taking it wholesale would have silently removed them, and the failure would
have surfaced as a deck that stopped rendering, days later, with nothing pointing here.

**That is the hazard this route exists to avoid, and it appeared in the first file touched.**

## A caveat on my own PDF proof, raised by `rc-read-pdf` after I released it {#port-a4}

It found that the PDF→canvas transform is **duplicated three times with the page box
hardcoded to `612 × 792`** — `pdfToCanvasLocal` in `server/routes/projects.mjs`,
`_pdfToCanvas` in `server/routes/history.mjs`, and the client transform. **My proof used
`bracket-test.pdf`, which is US Letter — exactly the size that hides this.**

**So I re-ran it on A4**, against the ported branch:

```
a4-page-1.svg  595 x 842 pts  svg:yes
page 1: 39 words, box 595 x 842
    "1"        x=130.052     y=157.341296  w=7.8   h=9.8
    "Bracket"  x=153.588744  y=157.341296  w=52.8  h=9.8
```

**The builder is clean.** `build-pdf.mjs` reads real dimensions per page from `pdfinfo` and
records them; there is no `612` in it, and the anchors scale correctly. **It also proves the
axes port did not break the PDF path**, since this run was against `rc-docformat` rather
than the old branch.

**The risk is real but it is not where I proved things.** The three hardcoded transforms are
*consumers* — the annotation and history surfaces — and a PDF document flowing through them
is step-two work. **Scoped, not dismissed**: whoever ports those sites has to make the page
box come from the manifest rather than a constant.

## Two more things from the same correction, both useful {#port-corrections}

**The chat artifact path already handles PDF properly** — `shared/chat-file-processing.mjs`
maps `pdf: 'application/pdf'` and `message-processing.mjs`'s `PATH_EXT` already makes a
`.pdf` in a message a clickable chip. `rc-read-pdf` had classified this as the cosmetic icon
group and corrected itself. It is a positive for the RC, not a gap.

**There is a second, independent `.pdf` membership rule.** `server/lib/shadow-repo.mjs`
ignores `*.pdf` and skips any `.pdf` with a sibling `.svg` via
`isGeneratedSvgCompanionPdf`. **So scope is decided by two different tests** — the source
manifest asks *is it in the include graph*, the shadow repo asks *does it have a generated
`.svg` sibling*. **A PDF document root must survive both or it gets no version history**,
and that site was missing from the original cost table.
