# Lab 1 lecture day — what happened, 2026-09-01

Skip taught QTM 285 at 16:00. He got a working deck at 15:48 with twelve minutes
to spare. This records why it took until 15:48.

## The one mistake, made three times

**A block present in both `_metadata.yml` and a document's front matter does not
merge. The file wins, whole.**

Three times I wrote a partial block into `lectures/Lab1-floor-slides.qmd` to add
one or two keys, and silently deleted everything else his `_metadata.yml` carried:

| when | what I added | what it silently removed | what he experienced |
|---|---|---|---|
| 13:02 | `height`, `width`, plugins | `controls`, `controls-layout`, `touch`, `smaller`, `slide-number`, `margin`, `scrollable`, `fig-align`, `fig-width` | no advance button, no zoom, unreadable plots, taps not reaching code cells |
| 13:02 | `revealjs-plugins: [svgzoom, …]` | the `svgzoom:` config block it requires | `svg-zoom.js` throws on init |
| ~15:00–15:16 | `webr: cell-options: fig-width: 14` | `packages: [ggplot2, purrr, dplyr, tidyr]` | ggplot2 never loads; `theme()` fails; **every plot in the deck is blank** |

He rediscovered each missing key one at a time, over two hours, under deadline,
and had to ask for `controls`, `touch` and `smaller` individually.

**Rule: restore the whole block or do not touch it.**

## Instruments that answered without measuring

Six wrong answers today came from checks that could not see the thing they were
asked about. This is [[the-instrument-or-the-code]] again, six times in one day.

- **`img` vs `canvas`.** A plot counter counted `img`; webR draws into `canvas`,
  and there are zero `img` on the page. It reported 0 plots forever, on every
  deck, at any timeout, with no error. Every "no plots" result today came from it.
- **A control measuring baked static images**, not webR output.
- **A storyboard shot count reported as a plot count** — I relayed "23 plots" to
  Skip; the browser said 14.
- **`proposal admission confirmed … state=complete` read as content landing.** A
  build proposal completing is not the bytes changing. I sent him a link twice on
  that basis and both times it served the old deck.
- **A grep for code in the served HTML.** webR cell code is base64 inside
  `<script type="webr-N-contents">`. Every grep any of us ran against it was
  vacuous.
- **Reading a file mid-render.** Two of us disagreed about a deck that changed
  underneath one of us, because a live server sat on the directory being rendered.

**The console had the answer three separate times while everyone reasoned about
source.** `could not find function "theme"` named the last break outright.

## What tlda cannot do, and it is why he could not present from the app

Established today, measured, not built on:

- **`page-info.json` splits a deck into one HTML document per slide** — 30 entries
  for a 28-slide deck. `loadSlidesDocument`, `src/loaders/slidesLoader.ts`.
- **The scripts in those pages never execute.** The console on the tlda page has
  zero webR lines: no runtime start, no package download, no R error. The same
  deck served raw has a console full of them. Static SVGs survive; everything
  JS-driven does not.
- **`tl-hit-test-blocker`, z-index 10000, `pointer-events: all`,** sits over the
  canvas. The code editors are at z 200, three layers below. Clicks never reach
  them.
- **Each iframe holds exactly one slide,** so reveal inside it has nowhere to
  advance to; tlda moves the camera between page shapes instead.

Net: **a reveal deck in tlda is a picture of a deck.** That is a product finding.
Nothing has been built for it and nothing should be without Skip asking.

## What he actually needed, in his words

> LITERALLY THE ONLY THING I CAN'T DO MYSELF IS SHOW THE SAMPLING DISTRIBUTION
> PLOTS HAVING INPUT A FAKE OR REAL POPULATION

Four steps: click into the population cell, type, run, distributions redraw.
Everything else — titles, layout, bullets, fragments, the pen — is decoration
around that, and he said so.

## Things his own files already answered

Five times the answer was in his repository while we derived it:

- `r-stack` — his idiom, in seven of his decks
- paired `data-fragment-index` with `.fade-out` / `.current-visible` — his overlay
  idiom, `Lecture1.qmd:216`
- `touch: false` — his own value, which I set to `true`
- `smaller: true` — his key, which I cut
- `with_annotations()` — his histogram idiom … **and a trap: it is defined in
  `shared-code.qmd`, a knitr include. It does not exist in the webR session.**
  Calling it from a `{webr}` cell throws.

**Two shared-code files, two runtimes. Check which one you are in.**

## Delivery

He presented from a plain reveal deck over the tailnet — no tlda, no split, no
auth, no token — served from `lectures/` on port 8899. 23 plots, ~5 minutes cold
warm-up while webR fetches the tidyverse.

### The instrument for a webR deck that looks wedged

**Canvas count is terminal. Running-cell count is live.** Measured 2026-09-01 on
his deck, PostMessage rig:

```
t=158s   35 cells running   canvas=0     <- looks wedged, isn't
t=341s   34 cells running   canvas=0     <- 183 seconds of this
t=356s   19 cells running   canvas=9
t=386s    0 cells running   canvas=21
```

**A 183-second window where fetches have stopped, nothing is drawn, and there are
no errors.** Indistinguishable from wedged by canvas count, and normal — first
plot lands at ~356 s.

**Every zero-plot report on 2026-09-01 was sampled inside that window.** The
running-cell count says "alive" at every sample within it. **Ask cells-running
before concluding anything from canvases.**

**This failure is distinct from the others above.** The `img` counter and the
spinner count returned *wrong* numbers. This one returns a *correct* number —
zero really was zero — **read as terminal when it was mid-process.** The defence
is not a better counter; it is a positive control establishing how long silence
lasts before silence means anything.
