# Edit Bridge — open work

Force-added deliberately. `scratch/` is gitignored, and this is a resumption
point rather than a report: it is what the next session works *from*, and a
chat message is not a record.

## 1. The compare affordances are in the wrong place — his, 2026-09-12 19:19:47 EDT

> "I'm just looking at the table of contents on this document. There's now a
> compare versions button that I didn't ask for. That literally, like,
> replicates the version wheel that already exists. Like, none of that is
> needed. You click the compare versions button, and then you gotta show diff
> or show edit bridge button. But that […] can just be on the […] timeline.
> Like, it can be on the same control as the scrubber for versions. Right?
> Like, there's no reason to have that in the table of contents. Like, it's
> just misplaced."

> "So this is by no means urgent, but I wanna record it as a thing that needs
> […] doing."  ·  "Doesn't seem very hard."

**The work, and nothing beyond it:**

- `Compare versions` comes **out** of `src/panels/TocTab.tsx`. Delete it, do not
  hide it or gate it behind a preference.
- `Show diff` and `Show edit bridge` move **onto the version scrubber** —
  `src/overlays/ShadowHistoryOverlay.tsx`, the control that already selects
  versions.
- Nothing left behind writing a value nobody reads. `AGENTS.md` §"A revert is
  not done until the control goes too" applies in this direction too: if
  `onToggleShadowHistory` ends up with no consumer again, say so rather than
  leaving a plumbed handler nothing calls.

**No archaeology into why it was in the TOC.** He withdrew that himself:

> "Honestly, they probably put it in there because I said to put part of it in
> there without thinking […] I wouldn't really worry about the why."

**For my own record, since it is the lesson rather than the task:** I added that
button to answer the storyboard walk's "two tabs to do one thing" finding. The
door already existed — the version stamp — so I built a second one instead of
moving the affordances to where the first one was. The finding was real and my
fix was in the wrong place.

**If putting them on the scrubber is genuinely awkward, that is a constraint
worth reporting** — different from archaeology, and worth knowing.

**Photographed by someone other than me when it is done**, per the standing
rule.

## 2. The high-zoom source hunk — §8, decided but not built

The chief's ruling: the **rendered difference on the card at rest** (built), and
the **source hunk reachable at high zoom** (not built). The server already has
the patch per build in `listVersionRange`; nothing carries it to the card,
because the route deliberately strips it — sending every build's full diff to
render a two-line excerpt is the opposite of §11's "visually compact".

So the shape is a reach, not a bigger payload: a card asks for its own hunk when
it is opened. `/history/shadow/diff?ref1=<parent>&ref2=<hash>` already exists
and answers exactly this.

## 3. Left unbuilt from his spec

- **§12** — annotation targets beyond a single build: a range, a trajectory, a
  cluster. Constraint already established: an annotation attaches to a build, or
  it pins the interval it describes. A stored note about a *moving* pair is the
  one shape that silently changes meaning.
- **§13** — the spatial sticky note. The note is a field on the card today.
- **§23** — coalescing, explicitly V2.

## Not mine

**The `nope` affordance.** Specified days earlier, recorded OPEN because he
floated two routings and chose neither, and it belongs on a build card or a
region-transfer card. `build-card-visible` owns that surface.
