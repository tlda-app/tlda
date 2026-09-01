# To-do

Things that need doing. Not a task list — a task records that an agent was
told to do something; this records work that is still outstanding, wherever it
came from: Skip's notes, chat, or something found on the filesystem.

Organised by topic. Status is a mark on the row, never the grouping.

`[ ]` open · `[~]` in progress · `[x]` done

---

## Chat

Source: three sticky notes Skip left on the `info` document, 2026-09-01
19:38–19:42 EDT. **His words are quoted; the rest is my summary of them.**

**Standing constraint on all of these, his:**

> I don't wanna fuck with that experience.

> we should do it as long as it doesn't break the fucking thing

> I don't wanna just, like, patch patch patch, but if we can understand what
> the fuck is going on, right, like, can just improve our design. **And if we
> can't understand what's going on, we can fix our fucking telemetry so we can
> understand what's going on.**

So: understand the mechanism, or improve the telemetry until you can. A patch
that makes a symptom go away without an account of it is not what he asked for.
`docs/chat-rendering.md` is the reference for the scroll model and says who may
write `scrollTop` and when.

- [ ] **The composer slider does not act where you release.** Hover is correct
      — it highlights the right target — and the action does not follow.

      > It seems like the composer slider is fucking broken again. Where, you
      > know, what the point where you release is, like, not the action doesn't
      > consistently happen. **It's not like it's missing what you're over. The
      > hover is right. It isn't fucking doing it.** So it's like, we gotta
      > fucking fix the correspondence between the fucking hover and the
      > fucking action actually fucking happening, bro.

      Note "again" — this has regressed before, so check history before
      treating it as new. Hover resolving correctly while the action does not
      says the hit-test is right and the commit path is wrong; those are
      different code.

- [ ] **The thread collapse control is in the wrong place.** It exists — it was
      previously reported missing, and it is not.

      > It turns out that it's there. It's just not in the right fucking place.
      > It's supposed to be in the fucking, like, **thread card, like, gutter or
      > whatever, like, on the left side.** It's just, like, right in the
      > middle, super awkwardly occluded by text, bro.

      > That seems like an easy fix, like, coordinate math.

- [ ] **Search is supposed to be in the sidebar and isn't.**

      > search, which is supposed to be in the fucking sidebar and just, like,
      > isn't

- [ ] **Scrolling feels non-linear — "warps".** Cause unknown and he says so.

      > it does feel like it sort of, like, has these, like, nonlinear warps.
      > Where you're, like, you know, like, you're scrolling, and then you come
      > across this big thing. It just feels like you move a ton or this, like,
      > big thing up appears, and it just, like, doesn't feel linear… you'll
      > scroll onto something, and then you move, like, forever. It takes
      > forever to scroll off of it

      > But it should be understood, and we should see if we could get it to
      > behave more linearly.

      He names the collapse defect as an aggravator, not the cause. Fixing
      collapse may reduce it and will not explain it.

- [ ] **Scrolling down sometimes fails to reach the bottom.** Recovering needs
      a scroll up and back down.

      > Occasionally, to hit the bottom, I have to, like, like, I'll scroll
      > down. I won't hit the bottom, and I'll have to scroll up and scroll back
      > down. It's annoying, but it's, like, absolutely not worth fucking
      > everything up over.

**What he says is working, so nobody "improves" it:**

> I'm pretty happy with the, like, chat Like, history, scroll back, whole
> system. Like, it's calm. It's good. It feels good.

> this sort of, like, chat system is, like, so much better than what we had
> before. But could use a little polish

---

## The app he uses day to day

- [ ] **The TOC should list slides as alternate versions of chapters.** His,
      2026-09-01 06:11 EDT.
- [ ] **The Sampling chapter is missing from the app.**
- [ ] **Never `Lecture X` / `Lab X` in the TOC** — *"labs are not a thing."*
- [ ] **A proper qmd project, so saving re-renders.** Today every revision cost
      a manual render plus a push, which is what made the polish window
      collapse before class.

---

## Slides and the window manager

- [ ] **External coordinate frame adapter in the WM.** His direction, 2026-09-01
      17:47. Design written: `scratch/external-coordinate-frame-adapter.md`.
      Not started, awaiting his read. **It replaces the splitter rather than
      adding a layer.**
- [ ] **`data-prevent-swipe` is never set**, so a pen stroke swipes the slide on
      his iPad in any deck that does not set `touch: false`. Fix written,
      unapplied.
- [ ] **`.drawable` under `revealjs`** — does it work, and can it borrow tlda's
      browse-tool *mode* model rather than fighting for z-order. His ruling:
      big canvas → tlda; otherwise → `drawable`; no middle ground.
- [ ] **`tldreveal` is deprecated** on his ruling. Removing it is not started.

---

## webR

- [ ] **Packages are refetched on every cold load** — 69 fetches measured on one
      deck. Either get the browser to cache them, or host them next to the deck.
      Parked: `fleet:9307-mtjaawxq`.
- [ ] **Extract requirements automatically**, including which tidyverse member a
      bare `mutate()` came from. Needs a symbol → package map.
      Parked: `fleet:9307-mtjab90z`.
- [ ] **Trim `library(tidyverse)` to the four packages actually used** in the
      Lab 1 deck. One line, measurable against a control.

---

## Course website

Owned by `course-website`. Design in `qtm285-1/scratch/naming-and-deploy-design.md`.

- [x] **Ten public pages serving full worked solutions.** Removed and deployed
      2026-09-01 19:29 EDT; all ten 404, book and front page intact.
- [ ] **Render homework pages from the generated handout, not the master**, so
      the published page never contained the answer. Control run: the handout
      transformation is exonerated; the obstacle was a test artefact.
- [ ] **Delete `encrypt-solutions`** — in the *same commit* as the wiring above,
      never before, or `OMIT_SOLUTIONS` goes and leaves a gap.
- [ ] **One repo.** Currently source and website are separate.
- [ ] **Rename to `chapter-<topic>` / `chapter-<topic>-slides` /
      `homework-<topic>`.** No numbers anywhere — his call, because a number is
      a position and positions shift when you insert something. Live URLs
      break, so redirects are part of it.
- [ ] **Syllabus link rule**: a link only if it has happened or is happening
      today. **Nine rows violate it right now**, all in the same direction — a
      future session carrying a link.
- [ ] **Thirteen of sixty-three chapters have no committed freeze result**, so
      CI would pay thirteen cold renders. Warm is 139s, cold ~900s, measured
      here — not a runner number.

---

## Fleet and tasks

- [ ] **Restore 79 overwritten task titles.** Mapping reviewed and approved;
      script written; runs against the store on the box.
      `scratch/title-restore-mapping.md`, `scratch/restore-task-titles.mjs`.
- [ ] **The title fix is not live** — it is an MCP tool-layer change and takes
      effect on MCP restart. Held while Skip is working. **Until then every
      re-delegation still stamps, so no bulk transfers.**
- [ ] **Mark the stale tasks done** once extraction is finished. His words:
      *"We don't delete tasks. I mean, we would mark tasks done."*
- [ ] **The bot existence test is keyed on name, not model**, so two rows of one
      model exist. `AGENTS.md` says that is impossible by construction.
      Parked: `fleet:9307-mtjabkhi`.
- [ ] **`<>` subscription notifications never deliver.** ~40 messages, zero
      notifications, both spellings. Live. Parked: `fleet:9307-mtjaxr1s`.
- [ ] **`dev` runs as `quiet-dev` and is therefore inert** — no worktree
      eviction, no preview reaping, since 2026-08-26. Same root cause as the
      bot existence test above.

---

## Found on disk, not yet anyone's

- [ ] **`sd-is-standard-prose.html` ships 13 HTML comments in its public
      source**, including planning notes and a line quoting Skip. Not an answer
      key; readable by anyone who views source.
- [ ] **An old commit deleted that page as "the remaining public solution
      page."** It has zero rendered solution callouts — the match was inside a
      comment. **Worth checking what else that pass removed on the same
      evidence.**
