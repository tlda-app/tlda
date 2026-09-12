# What a region transfer card is meant to show

Written before touching code. Source: `~/work/dot-claude/scratch/agent-edit-visibility-decisions.md`,
read end to end. Nothing here is originated; the citations are Skip's messages in that record.

## The form is the edit card's, not one of its own

Skip, 2026-09-12 18:39 EDT: *"i do want a region_transfer card"* · *"that was specified"* ·
**"it was meant to look like edit"**.

So the card is the ordinary edit-diff card, and where my description below and the edit
card differ, the edit card wins. What that card draws, checked in `renderEditDiff`
rather than assumed: a location header carrying the file's **basename** with `+n −n`
counts, then the two sides — `.diff-old` and `.diff-new` — rendered in the same way an
`Edit` on that file type would be (TeX as TeX, Markdown as prose, code highlighted). The
full path stays where every tool card puts it, on the call line.

`regionTransferEditInput` exists to feed exactly that renderer, so the design and the
code already agree; nothing about the form is work.

## The behaviour

When an agent calls `region_transfer`, the activity card that lands in the chat Skip is
looking at shows, with no hover and no expansion:

1. **The call** — the tool name and the target file it wrote to.
2. **The diff, side by side** — left, the exact bytes removed from the target region;
   right, the exact bytes copied in from the staging file. Nothing else, and nothing
   inferred: the design's own claim is that this operation's diff *is* exactly
   `old_string` → `new_string` (3805366 → 3805437, and the "converged design" section).
3. **Nothing duplicating it** — no raw result block under the card restating the diff.

It is sent **from the agent whose edit triggered it** (3803211, "Exactly. Send the card
from the agent whose edit triggered it."). An activity event already carries the agent as
`from`, so that is satisfied by construction and is not work.

## Why the diff is the whole point of the card

The card exists to make a bad edit *detectable immediately* rather than four edits later
(3802166). What makes region transfer worth a card at all is the invariant it buys and
Edit does not: **everything the agent types is verified, and everything that lands is
copied.** A card that names the call without showing what moved reports that an edit
happened and withholds the only thing he would look at it for.

## The bar

It must do this on a card that crossed the real wire — agent → daemon → server → store →
browser — not only inside one process. A renderer proven by calling the extractor and the
renderer in the same test proves the two ends and says nothing about the transport.

## Explicitly not mine

The **nope** affordance. Its behaviour is OPEN in the record: he floated both "posts a
chat message" and "maybe it does revert" (3802176, 3802177) and chose neither. If work
reaches it, stop and say so.
