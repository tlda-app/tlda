# Annotation threads

A marked answer is not ink on a surface. It is a thread of append-only
annotation layers, each carrying its own voice track, each living inside the
timeline of the one before it.

Skip, 2026-09-19:

> "annotations---like append only within the thread. like layer on layer"

> "voice sync, one per layer/message in thread"

> "there is a timeline to the original response. the next response like, lives
> within that timeline but has its own timeline---it constructs a warped version
> of the prev message's timeline where its annotations and audio live"

> "and so on"

## What a layer holds

Three things, and the third is the one that would otherwise be missed:

- **ink**, in the layer's own time
- **audio**, one track per layer
- **a warp** — a map from this layer's time into its parent's time

## Why the warp has to be recorded

Playing a reply means running its audio on its own clock while the warp drives
the parent's playhead. Pausing on a student's answer to talk over it, or
scrubbing back to something they did earlier, are both ordinary points in the
warp rather than special cases.

**It cannot be derived from the ink and the audio.** Nothing else records that
the reader stopped for nine seconds and then jumped back. A layer without its
warp is not a slightly lossy layer; it is a different artifact.

## Nothing is edited

A reply does not modify the timeline it replies to. It maps onto it. That is the
same append-only property as the layers themselves, one level up, and it is why
the thread composes: layer three warps layer two's timeline, which warps layer
one's.

It is also why returning marked work is a store **copy** rather than granted
access — Skip, 2026-09-18: *"i thought of 'return marked problem' as a store
copy, not a store like, give access by reference."* A copy is an append. A
reference is a mutation shared backwards.

## Scope

One thread per student × problem.

Related: the glass is an infinite pane whose origin is the callout's top-left
(see [the local layer](local-layer-window-manager.md)) — that is where a layer's
ink is expressed, and it is orthogonal to the timeline.

## Not settled here

Whether `0cec6662f` (*"additions-in-time — time-anchored marks on recordings"*,
authored by Skip, 12 June, not on `main`) is the mechanism for this or an
adjacent one. It appends marks to an existing recording's timeline; a thread
reply carries its own audio and its own clock. Skip: *"12 june was an
addition---append on top of extant recording? which is cool and i'd love to have
but isn't like, necessary."*
