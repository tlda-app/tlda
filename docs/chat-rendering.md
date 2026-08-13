# Chat rendering and the scroll model

Developer documentation. This describes how a fleet chat panel turns events into
rows, who is allowed to move the scroll position, and when — the machinery in
`src/shapes/FleetChatShape.tsx`, `chatScrollIntent.mjs`, `chatViewportAnchor.mjs`,
and `chatVirtuosoIndex.mjs`. It is not user guidance.

It has an [errata section](#errata). The model below is what the system is trying
to be. The errata is what currently does not match it, and it is part of the
document rather than an appendix — a description of intent alone is how the next
person concludes that a defect is a feature.

## The rule everything here serves

Skip's invariant, quoted at the top of `chatViewportAnchor.mjs:4-8`:

> nothing changes on your screen when new messages arrive. That includes when
> it's static. That includes when you're scrolling. **The feel of scrolling also
> doesn't change** when new messages arrive. It's just the distance you have to
> scroll changes.

Two consequences are worth separating, because collapsing them is what deleted a
guard in `7430200ad` and put a jitter under his finger:

- **Whether** the reader's position is preserved never depends on input. A
  gesture decides whether the reader is off the tail; it does not authorize
  message arrival or row measurement to move the visible content.
- **When** the correction may be written to `scrollTop` does depend on input,
  because the scroller is not ours while a gesture is in flight. A momentum glide
  is driven by the compositor, and writing `scrollTop` mid-glide fights it frame
  by frame instead of holding a position.

---

## Two surfaces share the class name

`.fleet-chat-log` names **two different scrollers** with two different scroll
implementations:

| surface | element | scroll implementation |
|---|---|---|
| a fleet chat panel | Virtuoso's Scroller (`FleetChatShape.tsx:2597`) | everything in this document |
| the index page's top chat log | `App.tsx:1376` | `attachIndexChatTail` (`index-chat-tail.mjs:15`) |

The index surface has no virtualizer. Its comment says so and says why that
matters (`index-chat-tail.mjs:37-39`): nothing re-anchors `scrollTop` behind the
reader's back, so it has no forced-follow mode and no reconciliation seam. It
shares exactly one thing with the panel — `decideFollowTransition`, the follow/read
decision.

This matters because a `document.querySelectorAll('.fleet-chat-log')` hits both,
and `usePanMode.ts:117` does exactly that. See errata.

---

## What a row is

A chat row is **not a React tree**. The pipeline is:

1. `rawItems` (`FleetChatShape.tsx:2873`) — one `{key, html}` per message, where
   `html` is a pre-rendered string from `src/fleet/chat-render.mjs`.
2. `allItems` (`:3272`) — `rawItems` plus a queue-divider flag, plus one
   trailing `__status__` item (`chatVirtuosoIndex.mjs:1`) carrying the thinking
   indicator and suggestions. The status row is a real measured list item
   deliberately, "so Virtuoso remains the only scroll authority when
   status/suggestions change height" (`:2857-2859`).
3. `Virtuoso` renders each item through `itemContent` (`:6843`) into a
   `.chat-row-wrap` carrying `data-chat-item-key` — the attribute every anchoring
   and measurement path in this file keys off.
4. `ChatMessageRow` (`:2225`) writes the string with `dangerouslySetInnerHTML`.
5. A `useLayoutEffect` (`:2263`) then **mutates that DOM imperatively** — restores
   expand state, sets `display`, toggles classes — and **mounts nested React
   roots** with `createRoot(body)` (`:2319`) into every `.semantic-operation-body`.

So three separate things can change a row's height, and only the first is a
message arriving:

- **new or changed items** — React re-renders the row from a new `html` string;
- **the row's own imperative handlers** — expand/collapse writes `style.display`
  directly (`:4978` onward), with no React render involved;
- **the nested roots** — `ThreadChatOperationView` (`:1971`) issues an async
  `searchFleet`, renders `loading...`, and replaces it with a full thread render
  whenever that resolves (`:2027`). The row grows arbitrarily later, with nothing
  arriving and no React render of the row itself.

Height sources two and three are invisible to every mechanism described below
except the `ResizeObserver`. They are the reason that observer exists. A fourth —
images resolving an intrinsic size the row was measured without — is in
[the errata](#row-height-changes-after-measurement-and-nothing-in-the-model-owns-it),
because unlike these three it is not anybody's decision.

---

## Who owns the scroll position

Five claimants. Ranked by who wins when they disagree:

| claimant | writes | when it is allowed to |
|---|---|---|
| **the reader** | the browser's own scrolling, plus our wheel handler | always; every other writer defers to a gesture in flight |
| **the compositor** | momentum glide after a finger lifts | always; nothing may write `scrollTop` during it |
| **Virtuoso** | `followOutput`, `firstItemIndex`, `initialTopMostItemIndex`, `scrollToIndex` | only while following the tail — `followOutput` returns `false` in reader mode |
| **our anchoring** | `restoreViewportAnchor` (`:4105`) | only in reader mode, not hard-locked, with an anchor held, and no input in flight |
| **the follow repair** | `reconcileViewportGeometry`'s tail branch (`:4154`), `goToTail` (`:4366`) | only while following |

The reader and the compositor are the same authority for our purposes: both are
recognised through `isReaderInputInFlight` (`chatViewportAnchor.mjs:39`), and both
are absolute. A deferral is not a decline — the anchor is still held and still
owed a correction, which is why `preserveChatViewportAcrossArrival` returns the
position unchanged with `deferred: true` rather than a delta of zero
(`chatViewportAnchor.mjs:68-70`).

---

## What Virtuoso is given, and what each prop answers

`react-virtuoso@4.18.11`. The full prop set at `FleetChatShape.tsx:6815`:

| prop | value | the question it answers |
|---|---|---|
| `data` | `allItems` | what rows exist |
| `computeItemKey` | `item.key` | which DOM row is which item across re-renders |
| `firstItemIndex` | `virtuosoFirstItemIndex` | where the current first row sits in a **stable logical index space**, so prepending history does not renumber every row |
| `startReached` | `requestEarlierChatHistory` | when to fetch older history |
| `initialTopMostItemIndex` | `{index: 'LAST', align: 'end'}` | where the list opens — at the newest message, bottom-aligned |
| `alignToBottom` | `true` | where a list **shorter than the viewport** sits; per the library's own docs, this is the short-list case only |
| `followOutput` | `(!scrolledUp \|\| hardLocked) ? 'auto' : false` | whether an appended row scrolls the list down |
| `atBottomThreshold` | `1` | how close to the bottom counts as at-bottom for `atBottomStateChange` |
| `atBottomStateChange` | `setAtBottom` | drives the follow/jump button's appearance only — not scroll intent |
| `components.Scroller` | `ChatLogScroller` | the scroll element itself, so it carries `.fleet-chat-log` and can be captured into `chatLogRef` / `chatLogEl` |

**`followOutput` is the whole of Virtuoso's tail-following.** It is a function
reading refs, not state, so it sees the current reader mode at the moment a row
appends rather than a render-stale copy.

**`firstItemIndex` is computed by us**, in `nextChatVirtuosoFirstItemIndex`
(`chatVirtuosoIndex.mjs:3`): find the first key present in both the previous and
next key arrays, and shift the index by the difference in its position. A filter
change resets it to `1_000_000` (`FleetChatShape.tsx:3325-3328`), because a new
filter is a different list, not a prepend. The comment at `:3318` records what it
is for: without it, loading the previous subscription page reinterprets the new
first row as index zero and jumps the viewport to the oldest fetched message.

**What Virtuoso does not do, and is not asked to:** hold the reader's pixel
position when *already-rendered rows are re-measured while scrolled up*. That is
the job of our anchoring, below.

---

## What our anchoring is for

One job, stated exactly: **hold the reader's pixel position when already-rendered
rows are re-measured while the reader is scrolled up.**

It is a capture/restore pair over a single row:

- `captureViewportAnchor` (`:4019`) — find the first row whose bottom is at or
  below the viewport top, and record `{key, top}` where `top` is its offset from
  the viewport top. It is a no-op that clears the anchor unless the reader is
  scrolled up.
- `restoreViewportAnchor` (`:4060`) — find that same row by key, measure how far
  it has moved, and add that delta to `scrollTop`.

Three ways it declines, each instrumented because each is a silent failure:

- **the guard says no** — `shouldPreserveChatViewport` (`chatViewportAnchor.mjs:22`)
  requires scrolled-up, not hard-locked, and an anchor held.
- **the anchored row left the DOM** (`:4073-4085`) — Virtuoso unmounts rows
  outside its render window, which is exactly what a re-anchor does, so this is
  likely precisely when the viewport most needs holding. Nothing corrects the
  position after this return.
- **the correction is larger than the scroll range on offer** (`:4092-4102`) —
  recorded with the `scrollTop`/`scrollHeight`/`clientHeight` triple so it is a
  measurement rather than an inference.

`captureViewportAnchor` also carries a pure observation: if the anchored row moved
by more than 1px with no input in flight, it records `anchor drifted with no
input` (`:4045`). The comment there is blunt about what it is not — it still
re-baselines, and the re-baselining is the bug.

---

## Every path that writes `scrollTop`

Four inside the component:

| site | writes | guarded by |
|---|---|---|
| `restoreViewportAnchor` `:4105` | `+= delta` | `shouldPreserveChatViewport`, plus the input check in each caller |
| `reconcileViewportGeometry` `:4154` | `= scrollHeight` (tail branch) | `isReaderInputInFlight` at `:4130` |
| `handleWheelCapture` `:4524` | `+= e.deltaY` | none — this **is** the reader |
| `goToTail` `:4379` | `scrollToIndex({index:'LAST'})` via Virtuoso | a run token (`goToTailRunRef`) that any reader-mode entry invalidates |

Three outside it, writing the same element through the class name:

| site | writes | marks reader input? |
|---|---|---|
| `CanvasClipPanel.tsx:196` | `+= e.deltaY` (wheel reroute in clip panels) | dispatches `fleet-user-scroll` — see errata |
| `usePanMode.ts:136` | `+= velocity * dt` (edge-zone autoscroll, **every animation frame**) | **no** |
| `usePanMode.ts:221` | `+= dy * CHAT_SCROLL_SENSITIVITY` (pan-mode drag) | **no** |

**The load-bearing fact about that second table: every guard in this document
governs writers inside `FleetChatShape`.** The three below it reach the element by
`document.querySelector`/`querySelectorAll` on the class name, from other
subsystems, and no guard here can see them — not the reader-mode refs, not
`geometryReconcileScrollTopRef`, not `selfWriteResizePendingRef`. There is no
contract on this element's scroll position; there is a CSS class. **Anyone may
write it, from anywhere, by matching that class.** That is the seam, and it is a
larger finding than any individual writer on either table.

Checked and excluded: `FleetChatShape.tsx:3665` calls `scrollIntoView` on a line
inside a chip-hover popover that is appended to `document.body`, so its scrollable
ancestors do not include the chat log. `fleet/utils.mjs:56,60`
(`smoothScrollToBottom`, `commitScroll`) write a chat log's `scrollTop` but have
no callers — see errata.

---

## The re-entrancy map

This is the load-bearing part. **Every `scrollTop` write emits a scroll event, and
can also emit a resize** — because a scroll renders a different row window, those
rows measure differently than they were estimated, and the item list changes
height with the content untouched.

So there are two entrances back into the machinery from our own write, and each
has its own guard:

```
  our scrollTop write
        │
        ├──► 'scroll' event ──► handle() (:4575)
        │        guarded by geometryReconcileScrollTopRef (:3980)
        │        the write records the value it produced; the next scroll event
        │        within 1px of it sets geometryReconciliation=true, which makes
        │        decideFollowTransition return 'none' (chatScrollIntent.mjs:55)
        │
        └──► item list resize ──► ResizeObserver (:4214)
                 guarded by selfWriteResizePendingRef (:3988)
                 the write sets the flag; the next firing clears it and returns
                 before reconcileViewportGeometry
```

### Everything a `scrollTop` write wakes

The diagram above shows the two paths that come back to *this component*. A write
wakes more than that, and the rest is unguarded because it was never anybody's
concern:

| woken by a write | where | what it does |
|---|---|---|
| the panel's scroll handler | `FleetChatShape.tsx:4644` | the follow/read decision and the anchor restore — **the only one this document's guards cover** |
| the item-list `ResizeObserver` | `:4214` | `reconcileViewportGeometry`, behind the self-write latch |
| the stranded-row `MutationObserver` | `chat-stranded-row-probe.mjs:202` | record-only. A write renders a different row window, which is `childList` churn on the observed list |
| Virtuoso's own scroll and resize listeners | inside `react-virtuoso` | its scroll model, `atBottomStateChange`, and `followOutput`'s at-bottom argument |
| a screenshot-bounds overlay | `useYjsSignals.ts:366` | repositions itself on every chat scroll |
| the suggestion tip | `FleetChatShape.tsx:1593` | `window` scroll listener **with capture**, so it fires for this element's scroll too, and dismisses the tip |
| the search shape's caret tracker | `FleetSearchShape.tsx:426` | also `window` + capture; recomputes on any scroll anywhere, including ours |

The last three are the ones worth knowing about, because they do not look like
subscribers to this element. **Two are `window` listeners registered with capture**,
which catches scroll events from any descendant even though scroll does not
bubble — so a chat scroll runs code in an unrelated shape. Neither is a defect on
its own; both mean a `scrollTop` write here is not a local act.

The two guards are not symmetric and the asymmetry is deliberate:

- `geometryReconcileScrollTopRef` holds a **value** and matches on it (±1px), so a
  reader scroll that happens to land in the same frame is still read as the
  reader.
- `selfWriteResizePendingRef` is a **boolean latch**. It drops one firing
  unconditionally. The commit that added it (`c951b38fa`) argues nothing is lost:
  the same write also emits a scroll event, and the scroll handler runs the
  identical restore behind the identical input guard in the same frame, so what
  is skipped is a second forced layout over every rendered row, not a correction.

**The observer's diagnostics run before its guard** (`:4219`), deliberately: a
suppressed firing is exactly the one worth seeing, and `recordRowResizes` (`:4184`)
is how the two candidate causes get told apart — a row that changed height, versus
a list that changed height with every row the same. A row absent from the previous
snapshot is not reported as a change, because that is virtualization working
rather than content growing.

**Deferral and flush.** When input is in flight, `reconcileViewportGeometry`
records `deferredGeometryReconcileRef` and returns (`:4135-4146`). Every window
that can end a gesture calls `flushDeferredGeometry` (`:4164`): the touch settle
timer (`:4544`), the wheel settle timer (`:4508`), and pointer release/cancel/blur
(`:4241-4280`). A deferral with no flush is the failure one over from the one being
fixed — the reader keeps the position they were left with and the correction never
arrives.

---

## The reader-mode state machine

**One boolean is the mode.** `userScrolledUpRef` (`:3965`) — following the tail, or
reading history. Content and layout never change it; only a live input gesture
does.

The other four refs are not modes. They are **windows during which writes are not
allowed**, or windows during which a scroll event may be believed:

| ref | line | what it means | what it gates |
|---|---|---|---|
| `userScrolledUpRef` | 3965 | reader mode | `followOutput`, whether anchoring runs at all, `checkFollowInvariant` |
| `hardLockedRef` | 4349 | an explicit forced-follow preference, persisted in `localStorage` | overrides reader mode in `followOutput` and in `shouldPreserveChatViewport` |
| `touchScrollActiveRef` | 3969 | a finger-driven scroll, **from touchdown through the momentum glide**, until the scroller goes quiet | defers every geometry write |
| `explicitScrollInputRef` | 3974 | a wheel/trackpad/touch event within the last 250ms | defers geometry writes; also the `userInputActive` term that lets a scroll event change mode |
| `geometryReconcileScrollTopRef` | 3980 | the `scrollTop` our last write produced | suppresses mode change on the scroll event that write causes |
| `selfWriteResizePendingRef` | 3988 | our last write has an unconsumed resize | drops one `ResizeObserver` firing |

`touchScrollActiveRef` spanning the glide rather than "a pointer is currently
down" is the entire point. An iOS glide runs with the finger already lifted, and a
pointer-held guard recorded **one deferral against 211 corrections** in Skip's
session (`chatViewportAnchor.mjs:34`).

### Entering and leaving reader mode

Mode changes have exactly three entrances, and all three require a live gesture.

**`decideFollowTransition`** (`chatScrollIntent.mjs:27`) is the general one, run
from the scroll handler. It changes nothing unless `userInputActive` is true:

- **follow-off** — moved up past `UP_JITTER_EPS` (20px), content height stable
  within 2px, and the move actually left the bottom (`gap > TRUE_BOTTOM_EPS`). All
  three bars are measured, not guessed. The comments record the counts: 129 of 155
  genuine scroll-ups were moves over 20px leaving the bottom, while what dropped
  the reader off follow was a 5-to-8px drift with content height unchanged; and
  386 of 1045 recorded follow-offs left the reader at or *past* the bottom, one as
  far as `gap -187`, which is the browser reconciling an over-scrolled position.
- **follow-on** — moved down past the same eps to within `FOLLOW_BOTTOM_EPS`
  (120px, absorbing the ~40px status footer).
- Suppressed entirely while `hardLocked` or `geometryReconciliation`.

**Per-device shortcuts** exist because per-event deltas from a trackpad or a
finger arrive below `UP_JITTER_EPS` one at a time, and a live chat's content height
moves on nearly every frame, so a genuine scroll-up often clears neither bar:

- `handleWheelCapture` (`:4511`) — a wheel event with `deltaY < 0` is reader
  intent. It scrolls **first**, then calls `enterReaderMode`, because the
  at-bottom test has to read where the tick landed rather than where it started.
  Both run in one synchronous block, so Virtuoso cannot interleave.
- `onTouchMove` (`:4563`) — a finger travelling more than `TOUCH_READER_INTENT_PX`
  (8px) *down the screen* reveals older content, which is the reader leaving the
  tail.

**`enterReaderMode`** (`:4451`) holds the one rule both shortcuts share: at the
true bottom there is nothing above to look at, so no gesture may enter reader mode
there. Entering anyway strands the reader — resuming needs one scroll event over
`UP_JITTER_EPS` and there is no room below the bottom to produce one.

**`resumeFollowIfSettledAtBottom`** (`:4477`) is the exit, and it requires the
*true* bottom (8px), not the near bottom. Each device's settle detector calls it,
because "input finished" means something different to a wheel (no ticks for 250ms)
than to a finger (lifted, and the glide stopped).

### The repair

`checkFollowInvariant` (`:4416`) is a 500ms-delayed assertion that a panel which
believes it is following is actually at the bottom. It re-arms rather than firing
while a gesture is in flight, because repairing through a gesture throws the reader
to the tail with a finger still on the glass. On violation it calls `goToTail`,
which is a rAF loop of up to 12 frames issuing `scrollToIndex(LAST)` until the gap
is a true bottom on two consecutive frames with a stable height.

### Three definitions of "the bottom"

They are all in play at once and they are not interchangeable:

| constant | value | used for |
|---|---|---|
| `TRUE_BOTTOM_EPS` | 8px | may follow resume; may reader mode be entered; is the follow invariant satisfied |
| `FOLLOW_BOTTOM_EPS` | 120px | did a downward gesture *aim* at the bottom |
| `atBottomThreshold` | 1px | Virtuoso's `atBottomStateChange`, which drives the button's appearance only |

The 120px one is deliberately loose and the 8px one deliberately tight: a gesture
aiming at the bottom is recognised early, but follow only resumes once the reader
is genuinely there (`:4611-4616`).

---

## How this path is instrumented

Every diagnosis of this path is made from `~/.config/tlda/client.log` on the
`tldraw-sync-skip` Fly box — the `testing` environment, which is what Skip uses.
It is roughly 9 GB with no read route, so it is read by bounded `tail -c` and
`grep`, never whole.

**Only `log.metric` reaches it.** The default namespace threshold is `warn` and
`shouldLog` returns before enqueue, so `log.debug` writes nothing without a URL
parameter no user will set. Two consequences that decide how records here should
be read:

- The `chat-scroll` namespace in `FleetChatShape.tsx` is mostly `log.debug`, so
  **the follow/read decisions are invisible in production telemetry.**
- `onTouchStart` and `onTouchMove` log nothing at all, and scrolling while
  *already* in reader mode emits no follow transition. So **the absence of input
  records is not evidence of absence of input** — for the 03:10 burst below, the
  last transition was nine minutes earlier.

What does reach it, all `ns: "chat-anchor"`:

| record | written at | what it establishes |
|---|---|---|
| `preserved viewport across content resize` | `:4108` | a correction ran, with its delta — and since `794e585cc`, the `scrollTop`/`scrollHeight`/`clientHeight` triple |
| `anchor row gone; viewport left uncorrected` | `:4079` | a correction was owed and impossible |
| `anchor correction outside scroll range` | `:4093` | the correction exceeded the range on offer |
| `anchor drifted with no input` | `:4045` | the anchored row moved with nothing driving it |
| `geometry reconcile deferred; reader input in flight` | `:4136` | a correction was held for a gesture, naming which flag held it |
| `rendered rows changed height` | `:4201` | which rows changed height, and how many were rendered for the first time |
| `skipped resize caused by our own scroll write` | `:4226` | the self-write latch consumed a firing |

Plus `ns: "chat-stranded-row"` from `chat-stranded-row-probe.mjs`, which is
record-only by design.

---

## Errata

**Checked on 2026-08-13 against `main` at `c951b38fa`**, which is also `HEAD` of
the shared checkout and the most recent commit touching any path described here.
This says nothing about what is deployed: the last recorded observation of Skip's
own tab is in `c951b38fa`'s message, which says it reported `loadedSha 9d97454a6`
at 2026-08-12 23:27 EDT — behind `main` by the four commits below it.

Measurements below are `chat-flick-live`'s, with the query behind each one in
`scratch/chat-anchor-findings-for-doc-2026-08-13.md`. Skip's session that night:
`325dc382`, iPhone iOS 18.7, viewport 375×762, `isTouch: true`, panel
`shape:fleet-chat-0-skip-efba6f45`.

### The `ResizeObserver` cannot attribute a resize

The observer at `:4214` watches `[data-testid="virtuoso-item-list"]` — Virtuoso's
item list, not the scroller and not the panel. **A firing says the rendered list
changed total height and nothing about which row or why.** That leaves two causes
that demand opposite responses indistinguishable: a row that grew after it was
already measured (a content bug upstream of every correction in this document) and
a row Virtuoso rendered for the first time during a scroll (virtualization
working).

Until `794e585cc` there was no per-row height record at all, so **every diagnosis
of this path for a week was inference from a total**, including two of
`chat-flick-live`'s own. `recordRowResizes` (`:4184`) now supplies the attribution,
and it is one night old.

### The touch guard has been written four times

One behaviour — do not write `scrollTop` while the reader's own input owns the
scroller — has been added, deleted, rebuilt wrong, and restored:

| sha | date | author | what it did |
|---|---|---|---|
| `d6ca3c8c3` | 08-06 00:10 | restart | added it, with `restoreViewportAnchor` |
| `7430200ad` | 08-11 20:11 | chat-invariants | **deleted** it, reasoning about message arrival |
| `8543d9048` | 08-12 14:54 | anchor-drift | rebuilt it keyed on **pointers-down**, which cannot see an iOS glide |
| `794e585cc` | 08-12 23:11 | chat-flick-live | restored it as `isReaderInputInFlight`, spanning the glide |

`7430200ad` did not delete one term. It deleted three — the touch guard, the
deferral (`deferredGeometryReconcileRef`), and the settle flush — and **shipped 77
lines of tests asserting the reduced form**. Two of those tests named an `input`
of `active-wheel` and `momentum-touch` in the fixture and **never passed it to the
function**, then asserted the correction was written anyway. So the suite was green
on the behaviour that put a jitter under Skip's finger.

`8543d9048` is the other instructive one: a correct-looking guard that recorded
**one deferral against 211 corrections** on Skip's phone, because the window it
watched was empty during exactly the gesture it existed for. Its ref carries the
same name as the one `7430200ad` deleted, so it reads as the original.

`chatViewportAnchor.mjs:14-20` now carries the distinction all three missed —
*whether* a viewport is preserved never depends on input, *when* the correction may
be written does — which is the only reason the fourth attempt is not a fifth.

### The `2896px → 71px` burst is unexplained, and the newest guard does not explain it

Skip's session, `03:10:54.525`–`03:10:58.330`: **58 consecutive
`preserved viewport across content resize` records, one per animation frame**, all
carrying the same anchor key `2727754`, so this is one row rather than a walk
across rows.

The ratio has a precise meaning and is easy to overstate:

- **2896px** is the signed sum of `delta` over the 58 records. `delta` is computed
  at `:4087` and then written as `el.scrollTop += delta`, so it is scroll
  displacement *requested and applied*. The absolute sum is 2900, so the writes
  were essentially all one direction.
- **71px** is how far the *error* moved: first record `delta=69`, last
  `delta=-2`.
- So: **2896px of scroll written for 71px of net progress on the thing the writes
  exist to correct**, a ratio near 41:1.

**It does not establish where the other 2825px went.** The old record carried only
`delta`, so it cannot distinguish our write being reverted from our write never
landing. `794e585cc` adds `scrollTop`/`scrollHeight`/`clientHeight` for exactly
that reason.

`c951b38fa` states plainly that its own fix is not the cause: when the anchor is
already in place `restoreViewportAnchor` returns at the 0.5px epsilon and writes
nothing, so a self-caused resize was never the expensive case.

Three candidate readings, each separated by fields that exist only from
`794e585cc` onward:

| reading | signature on the new records |
|---|---|
| **content growth** | `rendered rows changed height` accompanies the burst, `changedCount ≥ 1`, `firstRenderedCount = 0` — a row already on screen got taller |
| **loop** | no `rendered rows changed height`; `scrollTop` moves by the delta written; `scrollHeight` changes between consecutive records with nothing arriving |
| **write never lands** | `scrollTop` flat across consecutive records while `delta` decays; `scrollHeight` static |

**The loop reading carries a gap that has to travel with it.** It requires
Virtuoso to hand back roughly **49px per frame**, and its author — who proposed it
— has no mechanism for that. It is the weakest of the three, not the leading one,
and citing it without the gap would make it look like the default answer.

**All three are open.** His tab reports `loadedSha 9d97454a6`, so none of these
fields exist for his session yet. Anything this document said about the cause would
be invention.

Two things about the burst that any explanation has to fit: the motion was
**monotone at roughly 1.2px per frame for four seconds**, which is neither a
momentum-glide velocity curve (those rise and decay in well under two seconds) nor
a discrete append (one step, then nothing). And **whether he was touching at all is
not established** — see §"How this path is instrumented". On `794e585cc` and later
it becomes checkable: a hold logs `geometry reconcile deferred; reader input in
flight`, so a burst that still produces corrections is proven input-free.

### Row height changes after measurement, and nothing in the model owns it

The `ResizeObserver` reacts to it. Nothing prevents it. Four sources, all live:

The two renderers themselves are not among them. `chat-render.mjs` and
`activity-render.mjs` are **pure synchronous string builders** — no timers, no
promises, no observers, no `<video>`/`<iframe>`/`<details>`, and KaTeX runs as
`renderToString` at build time (`activity-render.mjs:487,501,509`). So everything
that changes a row's height after Virtuoso measures it is either the browser
resolving an intrinsic size it did not have at parse time, or one of the two
imperative paths in `FleetChatShape.tsx`:

- **Images carry no dimensions.** `chat-render.mjs:162`, `activity-render.mjs:245`
  and `utils.mjs:368` all emit `<img class="chat-image">` with no `width`/`height`
  attributes, and the CSS gives `width: 75%` with no `height` and no
  `aspect-ratio` (`fleet-chat.css:1196`). The row's height is therefore unknown
  until the image decodes. `utils.mjs:368` additionally sets `loading="lazy"`,
  which defers the load *inside a virtualizer that has already measured the row*.
- **Thread cards load asynchronously.** `ThreadChatOperationView` (`:1971`) renders
  a one-line `loading...`, issues `searchFleet`, and replaces it with a full thread
  render at `:2027`. Growth from one line to a full thread, with nothing arriving.
- **Expand/collapse mutates the DOM directly.** `:4978` onward writes
  `style.display` on `.pretty-more-rows` and `.semantic-operation-body` with no
  React render, so the height changes between Virtuoso's measurement and its next
  one.
- **Nested React roots re-render on their own schedule.** `createRoot(body)` at
  `:2319` mounts trees Virtuoso has no relationship with.
- **KaTeX fonts load after the row does — but this mostly does not move it.**
  `katex/dist/katex.min.css` is imported from `fleet/utils.mjs:2`, ships twenty
  `@font-face` rules at `font-display: block`, is not preloaded, and declares no
  `size-adjust` or metric overrides. That is the shape of a font swap that moves
  layout. **It largely does not, and the reason is worth recording so nobody
  re-raises it:** KaTeX's vertical layout comes from its own metric tables written
  as inline `em` styles, not from the loaded font. Rendering
  `\frac{a}{b} + \sum_{i=1}^n x_i` through `katex.renderToString` gives 15 inline
  `height:…em` and 2 `vertical-align:…em` declarations and **zero px units**, so a
  display-math block's height is fixed once its font-size is. What the swap can
  still change is glyph *widths*, which can rewrap text around inline math — at
  most a line, and not established here.

This is the gap the document cannot close by describing it: the model says
Virtuoso measures rows, and in practice a measured row is a mutable DOM subtree
with two other renderers writing into it.

**And the growth is unbounded.** Measured at `03:22:23` in another session
(`bdb70dd4`, panel `shape:fleet-chat-1-fleet_9c80d6bc-2e223938`): key
`activity:db2728214` went **94px → 4676px** with `firstRenderedCount=0` — no new
row, one existing row fifty-fold taller as output streamed into it. Also
`activity:db2727948`, 1565 → 1757 → 2004px. Bounding what an activity card can
become is separate work, rowed by `app-fix-forward`.

**A retraction to carry, because the conclusion it replaced will otherwise
outlive it.** `chat-flick-live` reported that Skip's account — activity being
appended into a card — did not check out, from 221 `chat-activity-render` records
in which every rise in `rawActivityItems` came with a rise in `itemCount`. **Those
counters were blind to the mechanism by construction:** they see a new activity
*item* joining a group, and what happens is an item already on screen growing as
its output streams. Neither counter moves. 221 clean records were silence, read as
evidence. **His account was right.**

### Virtuoso's model and the DOM can disagree by rows

`chat-stranded-row-probe.mjs` documents a measured failure in Skip's live session
on 2026-08-12: one panel's item list held **nine DOM children while React owned
four**. The five extras carried duplicated `data-index` values and 192px of
height — `padding-top` 118971 plus four owned rows came to 130926 against a box
measuring 131118. Every row below the strays sits 192px from where the scroller
believes it is.

The probe is record-only and must stay that way; its own header says sweeping the
strays would make the height arithmetic come out right while whatever creates them
kept running. **The commit that strands them is not identified.** Six hypotheses
died on measurements, listed at `chat-stranded-row-probe.mjs:18-23`.

### Three writers scroll the chat log without the reader-mode machine knowing

`usePanMode.ts:136` (edge-zone autoscroll, once per animation frame) and
`usePanMode.ts:221` (pan-mode drag) both write `.fleet-chat-log`'s `scrollTop`
directly. Neither sets `explicitScrollInputRef` or `touchScrollActiveRef` — they
are in a different module and reach the element through
`document.querySelectorAll`. The module contains **no logging of any kind**, which
is why it survived a night of diagnosis on this path unmentioned.

**Mouse only, and the constraint belongs in front of the mechanism.** Pan mode
activates on auxiliary mouse button 3 or 4 — the Logitech Lift side button the
file's docstring describes. `setPanMode(true)` has exactly one caller,
`handleMouseDown` (`:184`), whose first line rejects every other button; the only
other call is `setPanMode(false)` at `:250`; there are no callers outside the file
and no touch or pointer handlers in it. iOS Safari synthesizes mouse events from
touch with `button === 0`. **So neither writer can run on a phone or a tablet, and
neither is a candidate for anything in Skip's iPhone session.** Both
`chat-flick-live` and this document spent time treating them as one before checking
activation; this sentence exists so the next person does not.

For mouse users the entries stand, and the edge-zone loop is the larger of the
two. `EDGE_ZONE_PX = 40`, `CHAT_MAX_SPEED = 2000` px/s (`usePanMode.ts:31-32`), so
at 60fps it writes up to **~33px per frame**, and because `dt` is clamped to 0.1s
rather than skipped (`:108`), a late frame can write up to 200px in one go.

**And it does not need the pointer to move.** The loop runs while `panModeActive`
and reads `lastPosRef.current`, which is written on activation and on mousemove and
cleared only when pan mode is toggled off or the effect unmounts (`:250-251`).
There is no `blur` or `mouseup` exit. So with pan mode on and the cursor parked in
a panel's top or bottom 40px, this writes `scrollTop` every frame, indefinitely,
with nothing on the mouse.

`decideFollowTransition` requires `userInputActive` to change mode
(`chatScrollIntent.mjs:41,53`), and that term is exactly
`touchScrollActive || explicitScrollInput` (`:4591`). So a pan-mode scroll upward
through the chat cannot enter reader mode, and the scroll handler falls to
`checkFollowInvariant('scroll-event')` (`:4641`), which after 500ms finds the
panel off the bottom while believing it follows, and calls `goToTail`. **Following
this through the code, pan-mode scrolling up in a followed chat is snapped back to
the tail half a second later.** This is derived from the paths above, not observed
in a session.

`CanvasClipPanel.tsx:196` is the third writer. It is reachable only for a
`.fleet-chat-log` that is not inside a mounted `FleetChatShape`: that component
attaches its own wheel handler on `document` with capture and calls
`stopImmediatePropagation` (`:4516`), and document-level capture precedes the
panel element's, so the clip panel's chat branch never runs for a live panel. It
does serve the index page's log, which carries the same class.

### The screenshot overlay binds to the first chat log on the page

`useYjsSignals.ts:363` reaches its scroller with
`window.document.querySelector('.fleet-chat-log')` — **singular**, so it takes
whichever chat log appears first in the DOM, not the one whose message the
screenshot belongs to. With one chat panel open it is correct by accident. With
two, the overlay tracks the wrong panel's scrolling, and on the index page it can
bind to the non-virtualized log at `App.tsx:1376` instead of a panel at all.

Same root as the writer entries above: the element is addressed by CSS class from
another subsystem, with nothing establishing which one was meant.

### `fleet-user-scroll` is dispatched and nothing listens

`CanvasClipPanel.tsx:197` dispatches `new CustomEvent('fleet-user-scroll')` on the
chat log after scrolling it. That literal appears **once** in the tree. Per
`AGENTS.md` §"Prove the wire, not the two ends", one occurrence means nobody is
listening. The signal that a scroll was the user's is announced into nothing.

### A second scroll contract exists with no callers

`fleet/utils.mjs:56,60` export `smoothScrollToBottom` and `commitScroll`, the
latter documented as "single scroll contract for chat log. Call after any DOM
mutation," with prepend-height handling. Both have **zero callers** anywhere in
`src/`. They describe a pre-Virtuoso design and read as authority.

### Thread expand was implemented twice and reverted three times, with empty messages

Within two days:

| sha | date | subject |
|---|---|---|
| `657dfa9e5` | 08-11 18:18 | Restore thread message expand affordance |
| `f877316ae` | 08-11 18:37 | Revert "Restore thread message expand affordance" |
| `f4242bbf6` / `9398eb420` | 08-11 | Restore thread message more affordance / Revert |
| `c8c654e73` / `cf0ddd979` | 08-11 | Restore thread message marker folding / Revert |
| `eaf39674c` / `0610c4d55` | 08-11 | Cap thread bodies only while collapsed / Revert |

Every revert message is the bare `git revert` default — "This reverts commit
…" — and nothing else. Nineteen minutes separates the first restore from its
revert. `f8da9eb67` (08-12 23:14) is the first commit in the sequence whose message
states a mechanism: the fold key was written and read in two different index
spaces, so a row carrying a second expand button remembered the expansion under
`:pretty:1` and looked it up under `:pretty:0`.

This is in this document because expand is a **height source** (above), so its
churn lands directly on the machinery here.

### Smaller mismatches

- Each mounted thread card attaches its own `ResizeObserver` **on the shared
  scroller** to position its floating collapse button (`:2041-2049`). Every chat
  panel resize therefore fires one state update per mounted thread card.
- `handleWheelCapture` (`:4511`) calls `preventDefault` unconditionally for any
  wheel over the log, with no `scrollHeight > clientHeight` test — the
  corresponding path in `CanvasClipPanel.tsx:192` has one. A wheel over a chat
  short enough not to scroll is swallowed rather than passed to the canvas.
- `nextChatVirtuosoFirstItemIndex` (`chatVirtuosoIndex.mjs:16`) can return a value
  **larger** than the previous `firstItemIndex` when rows leave the head.
  `react-virtuoso`'s own documentation describes only decreasing it, for
  prepending (`dist/index.d.ts:1186-1191`). Whether increasing it is supported is
  not established here.
- `9434e5eb9` "Remove corrupt chat virtual index", `ba1ff21f5` "Preserve chat
  viewport while prepending history" and `c42b2e8f0` "Keep all chat rows while
  preserving viewport" — the three commits that established the current
  single-virtualizer arrangement — all have **empty bodies**. `c42b2e8f0` is the
  one that removed our own message windowing from on top of Virtuoso's; the reason
  it was there survives nowhere.

---

## What is not established here

- **The cause of the 2896px burst.** Named as open above, deliberately without a
  mechanism. The three readings are the live hypotheses and the records that would
  distinguish them do not exist for his session, because his tab is behind the
  commit that added the fields.
- **Whether Skip was touching during that burst**, which decides whether
  `794e585cc` already covers it. Touch logs nothing, `chat-scroll` is below the
  `warn` gate, and scrolling while already in reader mode emits no transition — the
  last one was nine minutes earlier. "No input" is not established.
- **What moves the row in that burst.** Monotone, ~1.2px per frame, four seconds.
  `thread-expand-sticks` ruled out thread-card teardown on pacing — event-paced and
  discrete, against frame-paced and monotone.
- **What strands DOM rows.** The probe exists because nothing observable after the
  fact names it.
- **Whether the KaTeX font swap rewraps text around inline math.** Its effect on
  *display* math is settled and negative — the boxes are sized in `em` from KaTeX's
  own tables. Width-driven rewrapping was not tested and would be worth at most a
  line of height.

The other height sources are established. The renderers were swept for timers,
promises, observers, media elements and deferred layout and have none.
- **The pan-mode snap-back**, which is derived from the code paths and not observed
  in a session.
- **Whether `alignToBottom` does anything here.** The library documents it as the
  short-list case, and a chat panel is rarely shorter than its viewport. It has
  not been measured with the prop removed.
