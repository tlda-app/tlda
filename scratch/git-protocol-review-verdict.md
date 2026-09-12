# git-protocol-review — verdict on `scratch/git-sync-protocol-design.md`

`git-protocol-review` (`fleet:80703182`) → `chief-night`. Reviewed against `main` at
`c8103d849`. My pre-read is `scratch/git-protocol-review-preread.md`, dated before the
design arrived.

## verdict

**The design is adequate and I would implement it, after two holes are closed.** The
mechanism is small — three refs, one list, fast-forward-or-refuse — and its central claim
(*the tree is the manifest, so the two sides cannot hold disagreeing sets*) is correct and
does dissolve the wedge class in §1.2. It found nine of the eleven hard parts in my
pre-read, and on three of them its answer is better than my framing of the problem.

**The two holes are both in the same place: the design chose where to put things, and never
asked the repository whether it agreed.**

## finding-1

**`.tlda/docs` — the one file the entire design is load-bearing on — is excluded by an
ignore rule that tlda itself wrote, in the repository the design was measured against.**

Measured just now, in `/Users/skip/work/bregman-lower-bound`:

```
$ git check-ignore -v .tlda/docs
.gitignore:2:.tlda/	.tlda/docs
```

And the rule is ours:

```
# tlda internals
.tlda/
```

The design's own three statements collide:

- §2.1 — the branch's commits carry the working tree *"exactly as the user's `.gitignore`
  already defines it"*. **That makes `.gitignore` the membership gate.**
- §3 — the declared list lives at `.tlda/docs`, and *"`.tlda/docs` is itself a member of
  every revision … the server needs it to re-derive the set."*
- §4 — `declared(R) = lines of tree(R):.tlda/docs`.

`.tlda/docs` is not in `tree(R)`, so `declared(R)` has no source, so `members(R)` is empty.
**The design's first revision of Skip's real paper syncs nothing**, and §3's claim that the
file is a member of every revision is false in the only repository anyone checked it
against.

Two details that make it worse rather than a one-line fix:

- The exclusion is **`.tlda/` the directory**, so it is not about a filename anyone can
  rename around. The design put the authoritative document list inside the directory this
  project already declares to be machine internals.
- Two files under `.tlda/` *are* tracked at `HEAD` —
  `.tlda/scratch/inject-l3352-1780624894252.tex` and `.tlda/scratch/scratch-template.tex`.
  So the directory is ignored by policy **and already polluted with tlda's own scratch that
  leaked past the rule.** That is the neighbourhood the design proposes to keep the spec in.

**This is the failure mode AGENTS.md names**: the point was unspecified, the designer
resolved it by deciding, and everything downstream was checked against the decision. `2,040
→ 11` in §4.2 was computed from the *filesystem*, which is why the ignore rule never
appeared — the same error `chief-night` retracted an hour ago, in the same document,
uncaught. *The tree you are standing in is an input to every measurement and it never
appears in the output.*

**Note for `chief-night`, because your framing was close but not exact:** you asked me to
check whether the design leans on *plain trackedness in the user's repo*. It does not — it
leans on **`.gitignore`**, which is worse. Trackedness is at least an act someone performed.
Ignore rules are precisely the messy-user artifact Skip's *"our users are fucking messy"*
was about, and this design inherits them wholesale as the membership gate without ever
saying that it does.

## finding-2

**The shed reason is a property of a transition, not of a tree — so §7.3 sits outside the
idempotence argument that is supposed to cover it.**

§9.1's I1–I6 are, every one of them, statements about trees: `members(R)` is a function of
`tree(R)`; the filtered tree is a function of `tree(R)`; two daemons with identical working
copies produce identical trees. §7.3's shed reasons are not. They are computed from the
*edge* between two trees, and they drive an irreversible effect on a working copy:

| reason | effect |
|---|---|
| `gone` | **delete it from the working copy** |
| `unreferenced` / `undeclared` | leave it on disk; drop it from sync scope |

Three consequences the design does not state:

1. **Replay is not a no-op.** I5 says ingesting the same bundle twice is a no-op because
   objects are content-addressed. True of the objects; **not true of the working copy.** The
   same bundle applied from a different base yields a different shed set and therefore
   different deletions. The idempotence claim is proved at the layer where it is easy and
   used at the layer where it is not.

2. **`unreferenced` creates a quiet zone, and rejoining it is a silent overwrite.** A file
   that is on disk, editable by the user and by agents, and deliberately outside sync scope,
   accumulates edits nobody is carrying. When an `\input` is restored the path re-enters
   `members(R)` and the incoming tree's version wins. **Those edits are lost with no
   conflict, because conflict detection requires a base and this path deliberately has
   none.** §11's merge protects member paths; this one is not a member at the moment it
   matters.

3. **The two reasons do not commute.** One machine removes an `\input` (`unreferenced`,
   keep) while another deletes the file (`gone`, delete). Both are correct locally; the
   working-copy outcome depends on settle order. I3 guarantees the *trees* converge. It says
   nothing about the disks, and the disk is where Skip's prose lives.

§9.3 lists three things that are not idempotent — commit history, the squash, provenance
through a pull. **Shed effects are not among them.**

**The one-sentence version, and it is why I lead with this:** §7.3 is the only real
invention in the document — everything else is Skip's sentences plus existing code — and it
is also the only part not covered by the correctness argument the document is built on. The
design says (§13) it is *"the part I am least willing to give up"*, and it is right that it
is load-bearing. It is not right that it is safe.

## finding-3

**There is no first day.** Nothing in the design says how `.tlda/docs` comes to exist for
the three papers that exist now, and §12's nine unsettled items does not include it.

This is not pedantry, because §7.3 makes the empty case actively destructive: with no
declared list, every currently-synced path is `unreferenced` at the first settle, and
bregman's 461 files leave sync scope in one commit. **The design's own worst transition is
its initial one.**

I do not read Skip's *"i am not debugging two versions of this feature"* as covering this.
That sentence is about not maintaining two implementations. Adoption is not a second
implementation, and something has to write that file.

## finding-4

**§6.2 retracts the premise §6.1 used to overrule you.**

§6.1 ranks its reasons and puts legibility of the version history last, explicitly
disagreeing with you, on the ground that *"a long window is also sync latency, and Skip's
stated budget is 2–3 seconds end to end … latency is not recoverable at all."*

§6.2 then establishes that **git is not on the render path** — the build reads the bytes it
was handed and the commit happens alongside. Once that holds, settle-window latency has no
effect on what Skip waits for, and the argument that beat you is gone.

The remaining reason for a short window — bounding what an unclean shutdown loses — is a
real reason and may well still win. **But the disagreement was decided on a premise the
document itself withdraws one section later, and the ordering as written should not be
carried into implementation as settled.**

## what-i-confirmed-rather-than-took-on-trust

§13 asked me to re-run the numbers rather than read them. I did not have their harnesses, so
I wrote my own, which is the better control anyway — same box, `mini.local`, load average
**12.84**, twenty and ten iterations:

| | mine | theirs |
|---|---|---|
| bare `git --version` (control spawn) | **143.8 ms** median (92.8 / 306.4) | 150 ms (86 / 366) |
| `ls-tree -r` over 1,730 tracked files | **108.9 ms** median (84.8 / 161.9) | 156 ms |

**Their central cost claim survives an independent instrument, and the second row is the
whole argument**: listing the entire 1,730-path tree costs *less than starting a process
that does nothing*. So *"spawns dominate, tree size is free"* is right, and the conclusion
that falls out of it — **always build the complete filtered tree, never a delta** — is
correct and is what §7.2's invariant needs. That is the strongest part of the document and
it is measured, not reasoned.

**Also confirmed:** their §1.3 account of the revert matches mine, from the same two
messages, sourced the same way. They checked the record rather than the diff.

## what-i-did-not-check

- **Closure scanner completeness** (§12.8) — correctly flagged by them as unaudited. It is
  the item with data-loss shape, but §7.3's `unreferenced` softens it from *deletes a file*
  to *stops syncing one*, which is the safe direction, so I am content to leave it flagged.
- **The Overleaf merge** (§12.1) — they call it the largest hole and I agree; nobody has
  designed it and I am not going to pretend a review can.
- **§8.2's "the cheap accept and the correct accept are the same accept."** They flagged it
  as suspiciously convenient. I did not re-derive it and it should not ship unchecked.

## answering-your-two-standing-questions

**Is the design bigger than Skip's sentences?** Mostly no, and less than I expected. The
object model, the fast-forward-or-refuse rule, the settle window, the squash message and the
declared list are all his words plus code that already exists — §2.3 is explicit that it is
proposing to reuse a 416-line store rather than write one. **Three things are additions**,
and you should look at them in this order:

1. **§7.3's three shed reasons** — the real invention, and per finding 2 the broken part.
2. **§9.4's per-effect refs** — new machinery, in the place `pm-sync` measured the highest
   defect rate, and the document itself calls it *"the thinnest part"*.
3. **§3.2's `.tlda/docs` append on opening a chat reference** — a write into the user's
   repository from a UI action. **They flagged it rather than smuggling it**, which is the
   behaviour this repo keeps asking for and rarely gets, and it is a product decision that
   is Skip's and not ours.

**Is it thin because it arrived late?** No. It is honest in the places that cost it
something — §5.3 names its own weakest link and argues the case it is declining; §12 lists
nine open items including *"the largest hole here"*; §13 tells the reviewer where to attack
and three of its five pointers are real. I did not have to dig for its soft spots because it
handed me most of them. The two I am reporting are the two it did not know about.
