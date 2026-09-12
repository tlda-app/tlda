# Browser lockup / memory investigation — report against the brief

Task `fleet:a879-mta8awxy`. Written 2026-08-27. Every claim below is measured
unless marked otherwise; retracted claims are named as retracted.

## 1. Exact reproduction

**Local, reproducible:** deployed build, disposable project, `pw setup` fleet
layout (6 chat rows, 27 shapes, 3 canvases). Reaches ~0.5 GB over six hours with a
floor rising ≈0.8 MB/min.

**The real failure is NOT this.** It is a tab holding a large document project,
measured live on his machine at **~12.9 GB resting**. I could not reproduce that
locally, and six hours of trying stayed two orders of magnitude short.

## 2. Memory growth over time

The signal releases at **three timescales**, and at each an instrument ignorant of
the next produces a clean-looking wrong answer:

| scale | behaviour | what it invalidates |
|---|---|---|
| ~20 s | ±4 MB wobble | any single sample |
| ~10 min | sawtooth, 50–145 MB releases | every minute-scale slope |
| hours | slow tooth | 40-minute "floor rise" readings |

**The only trustworthy metric found: post-release floors.** Eleven of them rise
391 → 652 MB over 5 h 20 m ≈ **0.8 MB/min**; whole-run and post-settling
derivations agree (0.82 / 0.75), the only rate in this investigation that survived
being recomputed.

**On the live heavy tab this metric does not work at all** — its whole hour of
variation (300 MB) is smaller than the releases the method detects at 0.5 GB.

## 3. First retained owner / allocation evidence

**Found and fixed one real defect**, by wrapping `requestAnimationFrame` in-page
and sourcemapping registration stacks:

`FleetChatShape.tsx` — the row `ref` is an inline arrow, so React reattaches it
every render and re-observes every row; `ResizeObserver` fires immediately on
`observe()`; the callback bumped `geometryVersion` unconditionally, so each render
scheduled the next. Measured **294 `observe()` + 276 `unobserve()` per 5 s against
geometry that did not change once in 120 samples**.

Fixed on `main` — `e65067f41`, `32512862e` — as a **correctness repair with no
memory claim**. Proven: 807 observe/10 s unpatched vs **1** patched, matched builds
one commit apart; and a delayed row-height change still pushes the row below by
exactly 300 px (0 px with observation blocked — red control).

**No retained owner found for the 13 GB.** That needs a heap snapshot or allocation
profile, not footprint sampling.

## 4. Slows or dies

**Dies.** Two `renderer_foreground` crash dumps at **15 GB and 12 GB**, ~90 min
apart. Live confirmation: a renderer at **12.7–13.0 GB**, and a CDP evaluate
against his tabs **timed out at 120 s** — consistent with the lockups reported.

## 5. Ruled out

- **JS heap, DOM nodes, listeners, canvas, images, iframes** — flat while footprint climbed.
- **The machine** — reproduced on a quiet box.
- **His debugging settings** — his own hypothesis, tested and negative.
- **The sync/network path** — offline made no difference (A-B-A).
- **`setInterval`, `setTimeout`** — excluded by ladder.
- **`rAF` as sole driver** — floor kept rising with the render loop fully stopped.
- **The row-observation loop as the memory driver** — A-B-A showed the apparent
  effect was burst decay. **This retracts my own earlier claim.**
- **Fleet-layout scale** — his fleet tab matches the local probe almost exactly
  (25 shapes vs 27, 3 canvases vs 3) and is healthy at ≤205 MB.

## 6. The exact remaining causal gap

**Why a tab holding a large document project retains ~13 GB at rest.**

Not a rate question: over a full hour that tab grew by nothing measurable. It is a
**retained working set**. The crash dumps read as a tab parked near 13 GB taking an
occasional burst on top — one such burst was caught, 12.7 → 13.0 GB in 3 minutes.

**Instruments do not transfer across the scale gap.** The floor/release method that
finally produced a trustworthy number at 0.5 GB is useless at 13 GB. Whoever
continues needs a heap snapshot or native allocation profile against that
condition, reproduced disposably with a synthetic many-page project — not a longer
footprint run.

## Corrections I made to my own reported findings

Listed because several were reported before being checked, and the pattern is the
finding:

1. **"Offline stops the growth"** — confound; the run stacked timer + rAF suppression.
2. **"This needs a CDP-attachable browser"** — false; an in-page wrapper got the stacks.
3. **"The `ResizeObserver` block names the offending callback"** — too strong; the reciprocal showed both links necessary.
4. **"The loop drives the memory growth"** — retracted by A-B-A; the drop was burst decay.
5. **"26 MB/min"** — a 10-minute window inside the burst timescale; retired as a rate.
6. **"~140 MB/min, 15 GB in 15 minutes"** — a 3-minute burst extrapolated; withdrawn within minutes.
7. **"Deep releases arrive once per 2.5 h"** — artifact of an arbitrary >100 MB cutoff; they are a continuum arriving ~every 30 min.

**Every one of these came from a window too short for the timescale it was
measuring.** The general rule for this system: no causal claim without a return
arm (A-B-A), and no rate from a window shorter than the slowest release cycle
present.

---

# 2026-08-31 — Retained owner found: detached SVG page content in Blink's Oilpan heap

Option 2 (disposable synthetic project) reproduced it. Nothing of Skip's was
touched; his tab was not instrumented.

## The reproduction

`synth-manypage` — a generated **500-page** LaTeX document, linked as my own
disposable project, built on the deployed server (500 pages, 12.7 s).

**Page count alone is not the driver.** Freshly loaded, the 500-page tab sits at
~397 MB — comparable to a 1-page project. **Visiting pages is the driver.**

| pooled tab, deployed build | footprint |
|---|---|
| baseline (loaded, no navigation) | 523 MB |
| after 40 page visits | 794 MB |
| after 80 page visits | 1243 MB |
| after collection | **712 MB** |

≈ **9 MB/page while active, ≈2.4 MB/page permanently retained** after collection.
JS heap stayed 50–58 MB and canvas count 3 throughout — the retention is neither
JS objects nor canvas rasters.

## The retained owner

`Memory.getSamplingProfile` was again useless (50 MB total, unsymbolised), and a
heap snapshot cannot see this because the JS heap is only ~40 MB of a ~700 MB
process. The instrument that works is a **memory-infra trace dump**, which
attributes native memory by subsystem.

**Delta across 60 page visits** (standalone CDP browser, same deployed build):

| allocator | before → after | delta |
|---|---|---|
| **blink_gc** | 76.1 → 128.9 MB | **+52.8 MB** |
| blink_objects/blink_gc | 0 → 48.2 MB | +48.2 |
| malloc/allocated_objects | 158.3 → 168.0 | +9.7 |
| partition_alloc | 37.7 → 40.6 | +2.9 |
| malloc | 267.2 → 269.5 | +2.3 |

**Blink's Oilpan GC heap grows ≈0.88 MB per page visited and dominates everything
else.** `malloc` is essentially flat.

**Per-class breakdown of what is retained:**

```
3.7 MB  SVGAnimatedLengthList      1.0 MB  SVGAnimatedTransformList
2.3 MB  blink::SVGLengthList       0.9 MB  SVGAnimatedNumberList
2.0 MB  SVGTSpanElement            0.9 MB  blink::FontResource
1.3 MB  Text                       0.8 MB  SVGAnimatedEnumeration
1.0 MB  blink::SVGLength           0.7 MB  blink::ScriptTimingInfo
1.0 MB  SVGAnimatedLength          0.6 MB  PerformanceScriptTiming
```

It is **SVG page content**. Document pages render as SVG; their element and
attribute objects survive navigation away.

**Confirmed detached, not live:**

```
Blink DOM counters:  36,360 nodes   (1,524 JS event listeners, 6 documents)
Live document:        3,337 nodes   (18 svg, 520 tspan)
```

**~33,000 retained detached nodes — 10× the live document.**

## Why every earlier instrument missed this

- **The JS heap is ~40 MB of a ~700 MB process.** `performance.memory` — what most
  instruments reach for — was watching 6% of the problem, which is why heap
  readings looked flat all along.
- **It is action-driven, not time-driven.** Idle tabs do not grow. Every
  time-based sampler in this file was measuring the wrong axis, which is why the
  rates kept contradicting each other.

## Consistency with the live failing tab

His fleet-layout tab matches the local probe and is healthy (≤205 MB). His heavy
tab is a many-page document worked in over days, and holds ~12.9 GB **at rest with
no idle growth** — exactly what an action-driven retention produces.

## Remaining gap

**What holds the detached SVG.** The retention is measured and localised, but the
specific retaining reference is not identified. Next instrument: Oilpan/Blink
retaining-path analysis on the same synthetic project — no access to his session
required.

## 2026-08-31 (later) — CORRECTION: the detached SVG is collectable

**I have to retract the retained-owner claim I sent earlier the same day.** The
detached SVG is **not permanently retained**. It is ordinary garbage that a forced
collection reclaims completely.

**The measurement that overturns it** — GC-bracketed, on the same synthetic
project, standalone renderer 26735:

| round | Blink nodes | live nodes | footprint |
|---|---|---|---|
| post-GC baseline | 5,734 | 3,337 | 269 MB |
| after 60 page visits (+2 quick GCs) | 61,591 | 3,337 | 316 MB |
| **one further GC, 6 s** | **5,730** | 3,337 | 284 MB |
| 3 more GCs | 5,730 | 3,337 | 282 MB |

Node count returns to baseline and **stays** there. Live count never moves.

**What that corrects, item by item:**

1. **"36,360 nodes retained against 3,337 live, ~33k detached"** — wrong. Those
   nodes were uncollected garbage; a forced GC returns the count to ~5,730. The
   residual ~2,400 over live is stable and unremarkable.
2. **"≈2.4 MB/page permanently retained"** — wrong. That was measured *without* a
   forced collection. After full collection it is **~0.2 MB/page** (13 MB / 60
   pages).
3. **"Retained owner: detached SVG in Oilpan"** — the SVG *is* what the memory is
   made of, and it *is* the bulk of the transient, but it is **not retained**. The
   allocation attribution stands; the retention claim does not.

**What survives, and it is still substantive:**

- **Page visits generate large transient memory** — ~9 MB/page while active,
  dominated by `blink_gc` and overwhelmingly SVG page content.
- **It is collectable.** Forced GC reclaims essentially all of it.
- **Persistent retention is small** — ~0.2 MB/page. At that rate 748 pages is
  ~150 MB, which **does not explain 13 GB**.

**So the boundary is not an application-owned reference. It is collection itself.**
The bytes are garbage that Chrome does not reclaim under ordinary conditions — my
pooled-tab run reached 1243 MB and natural release only took it to 712 MB, while a
*forced* GC on the standalone took the equivalent state to 282 MB. His tab sits at
12.9 GB **at rest with no idle growth**, which is consistent with a large volume of
collectable-but-uncollected page content rather than a reference leak.

**The honest remaining gap, restated:** not *what holds the SVG* — nothing holds
it — but **why collection does not reclaim it in a real session**. That is a
different question from the one I set out to answer, and I have not answered it.

**Method note:** the first two GCs after the visits returned 61,591; the third,
given 6 seconds, returned 5,730. **A GC that has not finished looks exactly like
retention.** Two collections were not enough, and reporting after two would have
produced — did produce — a false retention finding.
