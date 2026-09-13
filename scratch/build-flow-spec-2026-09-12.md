# Edit → preview → deployed site: behaviour and implementation

**Status: draft, 2026-09-12 evening.** Written by `build-process-owner-opus`
(build and deploy path) with `class-build-pm` (behaviour and the class
build-and-publish lane). **The implementation half below is mine and is the part
that has never been written down.** Wrong in specific places is the intent — it
is easier to correct a claim than to answer a question.

---

## Part 1 — What it does {#behaviour}

**This is the behaviour, written down as behaviour, so that the implementation
below can be checked against something. It is your design; the words are ours.**

### The loop, from your side

**You open a chapter in your course checkout and type. There is no command.**
Saving is publishing — the machine daemon sees the write, and that is the whole
of your involvement. You never run a build, never push, never stage.

**Within seconds the chapter you edited is rebuilt and on its map on the dev
server** — as a numbered book chapter, in the book's format, with its deck beside
it on the same map if it has one. **Nothing else in the book rebuilds.** A
seventy-six chapter book and a two chapter book cost the same for a one-chapter
edit, because the unit of work is the document you touched.

**The preview box shows the assembled book, and you did not do anything to make
that happen.** It is not a promotion you perform; it is a reflection of what the
dev server has. If it lags, that is a fault, not a step you forgot.

**Students get it when you decide, and that is the one deliberate act in the
whole flow.** One command, exact: the built artifact that the preview showed you
is the artifact they receive — not a rebuild, not a re-render, the same bytes you
walked through.

### What you can see without asking anyone

**Every chapter and every homework says whether what you are looking at is what
students have.** On the page itself and in the table of contents — a sync status
in the build-pill area rather than a banner that shouts. Not disruptive, and not
absent.

**That indicator compares against the published student site**, because that is
where students are. An indicator that compared the dev box to the preview box
would report health today and still leave the site advertising chapters it does
not serve.

**When a build fails, you are told.** The failure names what broke and where, on
the surface you are already looking at, and the last good page stays up
underneath it. You never learn that a build failed by noticing a page is old.

### The one property the whole thing is for

**What you see is what they get.** One source; the differences between the three
places are visible and named; and the only divergence that can exist is the one
you chose by not releasing yet.

---

## Part 2 — How it is built {#implementation}

### The pipeline that exists today

A save on disk reaches a served page through five stages. **All five run; none
of them is missing.**

1. **Watcher.** The machine daemon sees the write in the bound checkout. **No
   command, no staging** — saving publishes. **And nothing waits for anyone to
   open the page**: admission puts the build in the queue. Tested by pushing an
   edit and then requesting nothing for 135 seconds — the build ran on its own.
   *(The CLI prints "Source pushed; viewer rebuilds on demand", which is why an
   earlier draft of this said the opposite. The message is wrong, not the flow.)*
2. **Source transaction.** The edit is submitted as an immutable revision
   against the project's lifecycle store and accepted. **Measured: 4.2 s.**
3. **Build instance.** A private directory is materialised for this build:
   the previous output is seeded into it, the private caches are seeded, and
   the revision's files are written out.
4. **Render.** Quarto renders inside that instance.
5. **Publish.** The instance's output directory is swapped in, and
   `/docs/<project>/…` serves it.

**Two things that are already true and are worth knowing before anything is
designed.** The static page and the canvas are **the same bytes from the same
run** — `/docs/<project>/*` serves the build's own output directory, so
"generated from the same information" is not a gap and needs no work. And
**push-to-deploy runs**: each box serves what its remote holds.

**The chain exists as a command and not as a flow.** `tlda project promote
<name> --from <env> --revision <sha>` (`POST /api/projects/:name/promote`) moves
a **built artifact** between environments: the destination server fetches it
itself, nothing is uploaded, and the revision is exact. The help states the
reason in the Thursday ask's own terms — *"promotion is deliberately exact, so
that what students get is what somebody walked through."*

**What is missing is the caller, not the machinery.** Grepping for callers
outside the CLI returns the CLI and nothing else: **promotion runs when a person
runs it, and no edit, build, or deploy triggers it.**

*(An earlier draft of this section said "nothing promotes between them". That was
wrong — I asserted a feature's absence without running `tlda project --help` for
the noun I was making claims about. The gap is much smaller than I first said.)*

### Why developing a chapter is slow, which is the question asked

**Measured: 93 s from save to served — 4.2 s to accepted, ~89 s to built. ~48 s
of that is a phase that writes nothing to any log.** Not slow work being
reported — no report at all.

**That 93 s is `small-book-demo`, a fixture project, not your course**, on a box
at load 29. **Your book is larger**, and on the mechanism below that means
slower, not faster — but nobody has timed your book and this document does not
claim to have.

**That phase is materialising the build instance** — writing the revision out
file by file, plus four separate whole-project copies, three in
`materializeBuildInstance` (`server/lib/build-instance.mjs`) and one in
`buildQmdDocument` (`server/lib/build-qmd.mjs`). **Of those two things it is the
file-by-file write that costs, not the copies; that is measured below and it is
the opposite of what we assumed.**

**The cost is the number of files in the project, and the edit's own size never
enters it.**

**These are three fixtures I built for the purpose — not your course.** Real
builds on the real server through the real code path, but the projects are
disposable ones I made with controlled file counts, because a single build of
your chapter would be one point and consistent with several explanations. **So
this is evidence for a mechanism, not a measurement of what your book costs.**

| fixture | files | bytes | source phase | output seed |
| --- | --- | --- | --- | --- |
| small | 49 | 94 KB | 570 ms | 8 ms |
| large | 800 | 1561 KB | **6755 ms** | 1 ms |
| **control** | **49** | **1563 KB** | **434 ms** | 1 ms |

**The last two carry the same bytes and are 15.6× apart.**

**And the phase that costs is not the copying.** The output seed — the whole-tree
copy that was the obvious suspect — is **1 to 8 milliseconds**. What costs is
**reading each file out of git in its own `git cat-file blob` subprocess**, one
at a time, at **~8.5 ms per file**.

**That is the mechanism behind the bargain not holding.** A whole book is a large
file count, so every edit pays the whole book's subprocess bill however small the
edit. At 8.5 ms per file, a 3000-file book is ~25 seconds of process spawning
before anything renders.

*(An earlier draft of this section blamed the tree copy, from a synthetic
measurement showing copies to be per-file-dominated. That measurement was true
and about the wrong subject: copying is per-file-dominated and copying is not
where this build spends its time. The instrument on the real path corrected me.)*

**And there is a structural reason no amount of incremental rendering fixes
this.** Inside `buildQmdDocument` in `server/lib/build-qmd.mjs`, the order of
two calls settles it:

```js
cpSync(srcDir, outDir, { recursive: true })          // the whole tree
...
const incrementalRoots = nativeTldaProject
  ? qmdIncrementalRenderRoots(outDir, changedFiles)  // what actually changed
  : null
```

**The copy is paid before anything looks at what changed.** So even a perfectly
incremental render still pays the whole book's copy on every edit.

*(Cited by call site rather than by line number on purpose: the two calls sat at
830 and 836 in the worktree this was written in and at 769 and 773 on `main` an
hour later. A line number in this repository is stale by the time it is read —
`AGENTS.md` says so, and I got it wrong here first.)*

**So there are two floors, not one**, and they add: the per-file read above, and
this copy, which no amount of incremental rendering removes because it is paid
first.

**What is measurement and what is not, kept separate deliberately:**

- **Measured:** the 93 s / 48 s split; the **15.6×** between the two fixtures
  carrying identical bytes and differing only in file count; the line
  ordering above.
- **Not measured:** which of the four copies dominates a real chapter build.
  The instrumentation to say so landed tonight and **no real build has run since
  it did**, so the phase line does not exist yet.
- **A lead, not a finding:** the revision materialiser reads every file with one
  `git cat-file blob` subprocess per file, and a batched reader already exists
  beside it whose own comment prices the per-call cost at ~130–150 ms. At that
  rate a few hundred files is most of the 48 s. **This is arithmetic from a
  documented figure and a file count nobody has yet, not a measurement.**

### What to build

**The floor has to stop scaling with the project.** Three options, measured
rather than argued, 3000 files / 59 MB on a loaded box:

| approach | elapsed |
| --- | --- |
| `cpSync` recursive — what builds do today | 9.5 s |
| `cp -c -R` — APFS clone / reflink | **5.1 s** |
| plain `cp -R` | 13.7 s |

**Clone is roughly 2× the current path — not the order of magnitude that would
fix this.** It is worth taking and it is not the answer.

**A fourth row is missing on purpose.** My hardlink measurement came out at
28 s, which is **my script's cost, not hardlinking's** — it issued one `mkdir`
per file. **I am not reporting a verdict on hardlinks from it**, and it needs a
proper implementation before it means anything.

**And a caveat on the space half of the question.** `du` reports 59 MB for the
clone as well, so **this measurement cannot see clone sharing at all** and says
nothing about whether clones save disk. That question is open.

### Fixed, measured, awaiting a deploy {#the-fix}

**The revision is now read in one `git cat-file --batch` spawn instead of one
subprocess per file** — `2f754e888` on `main`. The batched reader already
existed in the store; the lifecycle facade never exposed it.

**Before and after, against the real store and the real materialiser:**

```
400 files, real git store

per-file spawns (before)   20990ms   52.48 ms/file   400 files / 798022 bytes
one batch spawn  (after)    1775ms    4.44 ms/file   400 files / 798022 bytes
```

**11.8× faster, byte-identical output** — same count, same 798,022 bytes. **The
equality is the load-bearing half**: a faster materialiser writing different
bytes would be a corruption that the timings alone would not show.

**Not yet confirmed on the server.** The prediction, posted before the
measurement: `copycost-large-800` falls from 6755 ms toward the 49-file
control's 434 ms. **If it does not, the change comes out.**

**The direction that actually removes the floor is not copying per build.** All
four copies exist so a render has a private, writable tree. **The fix is to stop
producing a whole private tree per edit** — the copy has to become proportional
to what changed, or disappear into a filesystem that shares unchanged blocks.
**Which of those is right depends on the phase line from the next real build**,
because if one of the four copies is 90% of the 48 s, that one is the whole job.

### What is hard about it, plainly

**The instance exists for a real reason and removing it is not free.** Builds
must not see each other's writes, a failed render must not take down the last
good output, and the publish is an atomic directory swap. **Any scheme that
shares a tree between builds has to keep those three properties**, and that is
the actual engineering, not the copying.

**The filesystem does not cooperate where it matters.** The build instance is
created in `tmpdir()`, which on the Fly boxes is **overlayfs**; the persistent
volume is **ext4**. **Neither supports reflinks.** So clone-based approaches
help the Mini and local renders and do **nothing** for the box that serves the
class — and moving the instance onto a reflink-capable filesystem is part of the
fix rather than an afterthought. **This is the concrete thing to decide with
you**: it is a provisioning choice (XFS `reflink=1`, or btrfs) as much as a code
change.

**The incremental path may already be built and switched off.**
`class-build-pm` has established that the doc-by-doc build specified on 09-10 is
implemented and gated by a condition broader than the spec, with 0 of the last 8
pushes reaching it. **If that holds, part of the answer is narrowing a gate
rather than writing anything** — but it does not touch the copy floor above,
because that is paid before the gate is consulted.

**Nothing here is offered as a reason it is not done.** The copy floor is a
day's work to attack once the phase line says which copy to attack, and the
gate is smaller than that.
