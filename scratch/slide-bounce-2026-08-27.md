# Continuous slide bounce — diagnosis and fix

`slide-bounce` (fleet:e290dd85), 2026-08-27. Task from `sol-dev`.
Commit: `c0b09c200` on `main`. **Not deployed.**

## What was reproduced

Read-only CDP against the live PIC tab (`tlda-pic`, project `qtm285-lecture-1`),
sampling the store every 150ms with nobody touching the machine. Two on-screen
slide shapes were changing height continuously:

| shape | values cycled through, 4.5s window |
|---|---|
| slide-8 | 1691, 2014, 2256, 2296, 2316, 2326 |
| slide-9 | 1294, 1426, 1492, 1525, 1541, 1549 |

The camera was constant at `(-17135, -405, z=1)` throughout, so this is shape
geometry and not camera motion. Continuous, with no interaction — which is
Skip's correction, not a one-time image-load jump.

The two that moved were exactly the two mounted in the viewport. Slides with no
iframe mounted, and mounted slides whose content fits, did not move.

## The mechanism

`reportSlideHeight` in `server/lib/html-injector.mjs` took the max of five
quantities. Two of them were `document.body.scrollHeight` and
`document.documentElement.scrollHeight`.

Reveal centres `.slides` in the viewport, so half the container falls below the
content and counts into both. Measured directly, holding everything else fixed
and sweeping the container height H:

| H | body/documentElement.scrollHeight | slide.scrollHeight | slide.offsetHeight | Reveal scale |
|---|---|---|---|---|
| 700 | 1621 | 1762 | 702 | 0.9000 |
| 1000 | 2062 | 1762 | 702 | 1.1057 |
| 1500 | 2312 | 1762 | 702 | 1.1057 |
| 2000 | 2562 | 1762 | 702 | 1.1057 |
| 2500 | 2812 | 1762 | 702 | 1.1057 |
| 3000 | 3062 | 1762 | 702 | 1.1057 |
| 1000 | 2062 | 1762 | 702 | 1.1057 |

The document-level figures are **H/2 + 1562**. H is the height the parent had
just applied *from this very report*. The slide-level figures do not move with
the container at all, in either direction — the last row is the sweep coming
back down, with no hysteresis.

The parent's slide branch in `src/shapes/HtmlPageShape.tsx` sets
`minH = current.props.h`, so a slide's height can only grow. Feeding it a report
that is an increasing function of the height it just wrote closes a positive
feedback loop with gain 1/2:

    H_{n+1} = H_n / 2 + 1562

Driving the real parent rule against a real slide, from H = 1691:

    1691 -> 2407 -> 2765 -> 2944 -> 3034 -> 3079 -> 3101 -> 3112 -> 3118 -> 3121

with gaps 358, 179, 90, 45, 22, 11, 6, 3 — halving, which is the signature
visible in the live sample above. The climb stops only when a step falls under
the parent's 5px gate, and restarts from the bottom whenever anything perturbs
the height.

## The fix

`c0b09c200`, one function in `server/lib/html-injector.mjs`. Report

    max(2 * slide.scrollHeight - slide.offsetHeight, slide.offsetHeight) * scale

Both terms are in the deck's authored coordinate space and are constant under
the sweep above. Because `.slides` is centred, content overflowing its slide
element by d needs d of room above it too, so the box that shows all of it is
`2*scrollHeight - offsetHeight`, or `offsetHeight` when nothing overflows.

That is the height the ratchet was climbing towards all along. On the probe
deck, slide 8 settles at 3121 against the ratchet's fixed point of 3122 — the
same geometry, reached in two writes instead of an unbounded chase, and then
silent.

Because the value no longer depends on the container, two clients looking at
the same slide now compute the same number instead of taking turns pushing
their own.

## What was verified, and how

Verified on `qtm285-slides-probe` on the dev box — a disposable deck, not a
project of Skip's. The function under test was **extracted verbatim from the
generated bridge** (`injectSlidesBridge` output), installed into the real slide
document, and driven against the real parent update rule, with the old
report stream captured alongside it in the same run on the same container.

    slide  settled  writes  then
    7      2506     2       quiet
    8      3121     2       quiet
    9      3406     2       quiet
    15     700      0       quiet (content fits; never writes)
    17     1541     2       quiet

The settled height was then cross-checked against two instruments that do not
share the formula's assumption — a walk of every descendant's
`getBoundingClientRect().bottom`, and a `Range` over the slide's contents —
both converted to a required height by the same centring relation. All three
agree, and all three are constant across the container sweep:

    slide   H=900        H=1500       H=2400       H=1500 (back)
    17      1540/1538/1541 (walk/range/formula), identical at every H
    8       3122/3122/3121 (walk/range/formula), identical at every H

**One thing I saw twice and am not hiding.** In two A/B runs where the deck was
driven up from H=700 through an exercise-loading transient, slide 17's element
collapsed to about half height with a loading indicator hanging below it, and
the report at that moment was 382px short of the content extent. Once the
exercise finished loading, the element returned to 1540 and all three measures
agreed again, as above. The old code's number in that same transient (1565,
then 1923) was container-derived, so it was not measuring the truth either. I
am recording this as an under-report during a transient on one slide, not as a
settled-state defect.

Checks that were run, including the ones that failed first:

- `node --check` on the .mjs caught a backtick in a comment breaking the
  injected template literal. `npx eslint | tail` reported exit 0 for `tail`,
  not for eslint — the pipeline status, which is the trap this repo already
  records.
- The injected script is a string, so `node --check` on the module cannot see
  it. The generated script is extracted and parsed separately. Positive
  control: appending `var x = (;` to the extracted script makes that check go
  red, so it can fail.

## What is NOT established

**What writes the height downward — now pinned by value, not by identity.**

The live PIC samples are not a scatter. Fitting `H_{n+1} = H_n/2 + c` to
consecutive observed rungs gives a constant c on both slides:

    slide-8, from 2256/2296/2316/2326:  c = 1168.0, 1168.0, 1168.0
    slide-9, from 1294/1426/…/1549:     c = 779.0, 779.0, 779.0, 778.5, 778.5

So the values in Skip's tab are exactly the rungs of the feedback law measured
on the rig — the law is confirmed on his surface and not only on mine. Their
fixed points are 2336 and 1558.

Running one rung backwards from the lowest observed value gives what the height
had just been reset **to**:

    slide-8:  (1691 - 1168) * 2 = 1046
    slide-9:  (1294 -  779) * 2 = 1030

Every **unmounted** slide on that canvas sat at exactly **1000** — the authored
height. So the downward writer resets a slide to its authored height, and the
1691/1294 I sampled were never a reset value at all, they were the first rung
of the climb back up. That is the loader asserting `page.bounds.h`, which is
what `createSlidesShapes` does unconditionally and what `createHtmlShapes` does
for slide URLs.

**Still not measured:** which of those two ran, and whether the write arrived
as `source: 'user'` or `'remote'`. That needs a store listener on a tab where
the bounce is live. See the next section for why I could not open one.

**One related thing the reverts missed.** `b5b6eb4e5` "Reset migrated slide
heights" (2026-08-27 14:20, an hour before the four rejected patches) added
`h = isSlide ? page.bounds.h : …` to `createHtmlShapes` — a downward writer for
slide heights on the HTML branch. The reverts `f96a67575..67e62b396` cover the
four later commits only; `b5b6eb4e5` is live on `main`. I did not touch it —
flagging it because it widened this exact disagreement on the same day, and a
revert series that stops short of the first commit in a theme is the shape this
repo already warns about.

Removing the loop's gain makes the ratchet a bounded two-step settle whatever
resets it, so the continuous bounce goes either way.

## Why I did not open a browser on PIC

Asked to take this route without Skip's tab, I did not, and the two reasons are
both hard:

- **The shared pool cannot make a read-only session.** `tlda-dev pw` appends
  `pw=1` to every URL, and `FleetIconPill.tsx:403` treats `pw=1` or
  `navigator.webdriver` as `automatedSession`, which selects the `3-col` preset
  and writes **six fleet shapes** into that project's synced room, once per
  launch, with nothing removing them. `qtm285-lecture-1` is a live course
  project. AGENTS.md is explicit that a browser goes at a disposable project,
  never one someone works in.
- **And it would measure nothing anyway.** PIC's docs are gated:
  `page-info.json` and the slide HTML both return **401** for me, and
  `~/.config/tlda/tokens.json` holds tokens for a different server (401 there
  too). An unauthenticated session loads the app shell (200) but no slide
  iframe, so no reveal, no reports, and no bounce. That is the
  environment-where-nothing-happens failure, and reporting from it would be
  worse than not running it.

Note the 401 bodies parse as clean JSON (`{"error":"Unauthorized"}`); read as
content rather than by status code they look like an empty result.

**Two writers still own one fact.** `createSlidesShapes` asserts the authored
`page.bounds.h` (700 on the probe deck); the measurement asserts the content
height (3121 for slide 8). They disagree by design and always did. Settling
that — most plausibly by having the build put real per-slide content heights in
`page-info.json` so the loader owns the height and the client never measures —
is a design decision about ownership, not a bug fix, so it is written down here
rather than built.

## The gates, run — on a real slides surface with the fix loaded

Superseding the "could not run" section below, which stood until Skip said to
test however I wanted.

**The surface.** `tlda-dev serve --sandbox` stands up this worktree's `main` as
an isolated preview with its own projects dir and DB — a server running
`c0b09c200` **without a deploy**. On it, a disposable 6-slide reveal deck
(`slide-bounce-probe`), built by the project's own `buildQmd`, two of whose
slides overflow the authored 700px box.

**Positive control that the fix is actually loaded**, since a deployed sha is
not a loaded module: fetching a slide off that server,

    grep -c "2 * (slide.scrollHeight"                       -> 1
    grep -c "documentElement ? document.documentElement…"   -> 0

**Criterion 3 — no continuous bounce.** Parked on the tall slides, twice for
12s and once for 15s after a full reload: **0 height writes, 1 distinct height
vector**. Heights `[700, 700, 2475, 1856, 700, 700]`, unchanged throughout.
Forcing a reset to the authored 700 produced **exactly one write**, `700 →
2475`, and then silence — which is the property that makes the bounce
impossible whatever does the resetting.

(The deck has 6 slides, so "slide 9 and later" has no literal counterpart here.
What it stands for — a slide whose content overflows the authored box — is
covered by the two that do.)

**Criterion 4 — tabs/clicks and arrows.**

| action | result |
|---|---|
| ArrowRight ×3 | 1/6 → 2/6 → 3/6 → 4/6, camera moved each time |
| ArrowRight across a fragment | 5/6 → 5/6(1/2) → 5/6(2/2) → 6/6; the fragment step moved no camera, correctly |
| next-slide button, real `.click()`, from a non-last slide | 3/6 → 4/6, camera moved, not disabled |
| next-slide button on the last slide | correctly disabled, no movement |

**Criterion 5 — permanent pen marks.** A real stroke through tldraw's own
pointer pipeline with the `draw` tool: 0 → 1 draw shape, survived four
navigations, and still present after a **full page reload** — so it is in the
synced room, not just in memory.

**Criterion 6 — no deployment.** A worktree preview is not a deploy. Nothing
was pushed to any deploy remote and PIC was never touched.

### Width: Skip is right, and there is no authored-vs-rendered distinction

He expects **1290**, from the iPad Pro. Checked, and the answer is that the two
things I had been calling different widths are **one number copied unchanged**:

    Reveal.initialize({ width: 1290 })      the deck's authored width
      -> page-info.json  width: 1290        readDeckDimensions() greps that block
      -> shape.props.w   1290               layoutPageBounds copies page.width, no scaling
      -> iframe.clientWidth 1290            the iframe is the shape
      -> Reveal.getConfig().width 1290

All five measured equal on the rebuilt deck. So a slide shape is exactly as wide
as the deck was authored, and 1290 is that number for his deck.

**My earlier 1050 was my own deck, not a finding about his.** Quarto's revealjs
default is 1050 and I had not authored a width; the harness meanwhile used 1290,
copied from what I had measured on his canvas. **That mismatch was the entire
"wrinkle" below** — a 1050-authored deck driven in a 1290 container — and it was
mine, not the fix's.

Rebuilt at `width: 1290`, everything is consistent:

| H (container) | old law | new law | old grows? | new grows? |
|---|---|---|---|---|
| 700 | 1673 | 2382 | yes | yes |
| 1000 | 1691 | 2382 | yes | yes |
| 1400 | 1891 | 2382 | yes | yes |
| 1900 | 2141 | 2382 | yes | yes |
| 2382 | 2382 | 2382 | **no** | **no** |
| 1400 (coming back down) | 1891 | 2382 | yes | yes |

`old = H/2 + 1191` with c constant to the unit across four heights, fixed point
2·1191 = **2382**. `new` is **2382 at every container height including 700** —
container-independent, with none of the height-bound jump the mismatched run
showed. And the app settles that slide at **2382**, matching exactly.

**Does the fixed-point comparison change? No.** At both widths the two laws
agree at the fixed point — 2475 at width 1050, 2382 at width 1290 — and they
always did; that was the original finding. What differs is only the path to it:
the old law approaches by a halving ladder that any reset restarts, the new one
returns it immediately from any container height.

One thing worth knowing for future comparisons: heights across widths are **not
related by a scale factor**. 1050 gave 2475 and 1290 gave 2382 for the same
source, because a wider slide wraps less text and so needs less height.

### The counterfactual at the mismatched width, kept for the record

Holding a container at fixed heights against the same server, the **old**
expression grows at every height tested — `old = H/2 + 1520`, so
`oldGrows: true` at H = 700, 1000, 1400, 1900, 2475 and again at 1400 coming
back down. That is the ratchet, on this deck, confirmed independently of the
PIC measurement.

**Superseded by the section above.** That harness ran at a 1290px container
while *that* deck was authored 1050 wide, so it was the wrong width for the
deck under test, not a second valid geometry. Its numbers (fixed point 3041)
describe neither the app nor his deck. The re-run at a matching 1290 is the
one to read.

An earlier attempt at this sweep **inside** the app failed to measure and I am
recording it rather than dropping it: setting the shape's height and reading
back 1.4s later always returned `H = 2475`, because the patched code had
already corrected it. The instrument answered; it did not measure the state I
asked about.

## Interaction surfaces — the argument that preceded the gates above

Slide tabs and clicks, arrow navigation, the edge tap zones and permanent
pen/highlighter marks are all parent-side, in `SlidesNavigator.tsx` and
`HtmlPageShape.tsx`. This commit changes one measurement function on the
server, and none of the four reverted patches (`e4714eee6`, `73fcd53d7`,
`460e1b4b0`, `3c8020158`) is replayed — all four were client-side changes to
navigation and shape sizing.

That is an argument from the diff, and `sol-dev` was right to ask for more.
Here is what happened when I tried to run the gates, and why it is not a gate.

**I could not drive them against the patched code, and the reason is
structural.** The fix is server-side. `main` carries it; no server runs it. A
deploy is out of scope by the task, there is no local slides project on this
machine (`server/projects` is empty), and building a deck locally means a
quarto render plus reveal assets — a fresh environment I would then have to
trust, which is the failure this repo already names.

**And the dev box could not stand in for a baseline either.** Driving the app
on `qtm285-slides-probe`, every control came back absent — no prev/next/
next-slide button, no counter, arrows moving the camera 0px, a real pen stroke
through tldraw's own input pipeline producing 0 draw shapes. That is not a
finding about the app. `document.body` does not carry `slides-mode` and
`.slides-navigator` is not in the DOM on that project, so `SlidesNavigator`
never mounted: the deck renders as plain `html-page` shapes. Nothing could
have happened, so nothing happening says nothing.

(Worth noting separately: that project's canvas also holds `fleet-search`,
`fleet-agents`, `fleet-docview`, `fleet-inbox` and `fleet-chat` shapes — the
six an automated browser launch writes into a room. Expected on a probe
project; it is why this work stayed off anything of Skip's.)

**The exact missing proof**, so nobody records this as covered: a server
running `c0b09c200` with a deck whose project resolves to `slides` format, and
on it — arrow left/right across a slide boundary and across a fragment, a
click on the next-slide control, and a pen stroke that survives navigating away
and back. Everything else in this report is measured.

**And the trap in setting that up.** The gate is `SvgDocument.tsx:483`,
`document.format === 'slides'`, which is what renders `SlideNavWrapper` at
line 1585. It is false on `qtm285-slides-probe` today. But that project still
shows **18 shapes with `…-slide-N` ids**, which is what `createSlidesShapes`
produces — leftovers persisted in the synced room from when it was in slides
format, not evidence the client is in slides mode now. Anyone preparing this
gate will see slide shapes on the canvas and reasonably conclude the surface is
right. **Check for `.slides-navigator` in the DOM, not for slide shapes.**
