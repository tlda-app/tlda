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
