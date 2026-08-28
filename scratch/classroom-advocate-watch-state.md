# classroom-advocate — watch state

Resumption point for the classroom recovery advocacy (task `fleet:22de-mtdcomgk`,
delegated by sol-dev 2026-08-28 15:34 EDT, due midnight 2026-08-28).

**Role:** independent advocate. I verify; I do not build. Findings go to
`alassroom-pm`, `root`, `sol-dev`. **Never to Skip.**

## Controlling spec — Skip's own words, 2026-08-28

- 15:30:12 *"a fucking enrollment page that fucking works"*
- 15:30:18 *"and a fucking book page that works"*
- 15:30:45 *"it is fucking blank"*
- 15:31:35 *"produce something that actually fucking works as specified"*
- 15:31:53 *"this is like, how i recover. it must be done by midnight"*
- 15:33:30 **"NOT SUBAGENTS"**
- 15:34:47 decouple a functioning system from building the whole book
- 15:36:04 full-process proposal for writing, deploying, teaching
- Earlier: 13:44:21 HW−1 content = setup instructions + picture exercise;
  14:15:13 template download + submit button on the hws; 13:47:11 he must see
  that students submitted; 12:41:18 **no separate handouts**.

**Live correction received 15:5x** (via sol-dev): there is no real gradebook to
protect — use a real test student in the actual public `qtm285`. My earlier
throwaway-course caution was wrong and is dropped.

## Environment facts I established

- **Public box is `tlda-pic`** → `https://tlda-pic.cormorant-matrix.ts.net`.
  Public DNS returns `208.111.34.11` / `208.111.35.209`.
- **`tlda-pic-dev` is tailnet-only** — no public A record from 1.1.1.1 or 8.8.8.8;
  tailnet resolver gives CGNAT `100.69.16.123`. Students cannot reach it.
- `pic` read token: `fa32c1eba25856d3368003cb0689ab66` (from sol-dev's 14:17
  message to Skip). **rw token** `X4GPMEbsY9xfMVcxejSLxUtHto7oSEv626C1ugN7ELM`
  (from `alassroom-pm`, read off the box). Neither goes to Skip.
- My test students: `qtm285:advocate-check-1` (submitted HW−1 + photo),
  `qtm285:advocate-check-2` (registered only).

## Verified PASSING — do not let anyone rebuild these

- **Registration works.** `POST /api/classroom/courses/qtm285/register` → 201.
- **Course + assignment exist on `tlda-pic`**: `hw-minus-1-setup`, due 2026-09-03.
- **`qtm285-book` is built and correct**: 3 pages, `renderedFormat: html`,
  roots in order — `lectures/Lecture0-prose.qmd`, `homework/hw-minus-1-setup.qmd`,
  `homework/week0-homework.qmd`.
- **Book content is NOT blank server-side**: 28,185 / 1,821 / 42,144 chars of
  visible text.
- **Photo submission round trip PASSES end to end**: upload 200 → receipt 200 →
  submission project built in 6 s → rendered page carries `<img src="my-photo.png">`
  → the PNG serves back **70 bytes in, 70 bytes out**.
- **Correct student link shape, driven with a cookie jar:**
  `/auth/login?token=<READ>&redirect=%2F%3Fworkspace%3Dclassroom-register%26course%3Dqtm285%26project%3Dqtm285-book`
  → 302 + `Set-Cookie`, redirect keeps `project`, register on cookie alone → 201.

## Open defects

- **D1** — template download `handouts/hw-minus-1-setup-handout.zip` **404s**.
  Cause: assignment has `templateDocKey: null`, `templateVersion: null` — the
  freeze step never ran. Also disables the archive check
  (`server/routes/classroom.mjs:203-213`).
- **D2** — the `Register for the class` link **inside HW−1** is the bare
  `?workspace=classroom-register&course=qtm285` — no `project`, no token. Authored
  in the `.qmd`, so it needs a re-render, not just `cli/tlda.mjs:2998`.
  `ClassroomRegistration.tsx:15` renders Continue only when `project` is present.
- ~~**D3**~~ — **CLOSED, verified by me with the rw token.**
  `GET /api/classroom/courses/qtm285/status` → 200, and the list distinguishes
  submitted (`ungraded`) from `not-submitted`; my `advocate-check-1` shows
  submitted. `counts: {missing:2, ungraded:2, graded:0, returned:0}`. Panel
  *render* still unverified — same auth path as D4, so worth eyes.
  Link: `/auth/login?token=<RW>&redirect=%2F%3Fworkspace%3Dclassroom-gradebook%26course%3Dqtm285`
- **D4** — **a 401 renders as a blank book.** `src/loaders/htmlLoader.ts:44`
  `fetch(...).then(r => r.json())` has no `r.ok` check; the 401 body is valid
  JSON, so `pageInfos` is an object, `.length` is `undefined`, and
  `while (i < undefined)` at line 61 never runs. Zero pages, no throw, no error.
  Confirmed both halves. Fix is `if (!r.ok) throw`.

## Corrections I have already issued against myself

- F2's original recommended link (`/?…&token=`) **does not authorize** — the SPA
  index is not behind `requireRead`, so no cookie is set. Superseded by the
  `/auth/login` form above. Caught by running it before it was used.

## STATUS 20:50Z — deploy landed, book down

- **Deploy landed 20:41:02Z: `d41f6839e`**, bundle `assets/index-DZAEa7P8.js`.
  Took 96 min (box was at load average 60). My stalled-deploy flag was answered:
  the deploy was genuinely still running — PM showed the server-side log still
  being written. Neither documented failure mode applied.
- **D2 app-code half CONFIRMED FIXED in the shipped bundle** (I read it, not the
  sha): `t = n.get("project")`, ternary `a && t`, `set("project", t)`.
- **🔴 `qtm285-book` is DOWN.** Was serving at 19:30Z; 404 by 20:45Z.
  `page-info.json`, `Lecture0-prose.html`, `week0-homework.html` all 404;
  `hw-minus-1-setup.html` still 200. Project record still says `pages: 3` and a
  successful `lastBuild: 18:50:32Z` — **the record reads healthy while nothing
  serves.**
  Cause (PM, from `classroom-hw1-handout`): `tlda project push` **mirrors the
  directory, not the tracked tree**, so a checkout carrying untracked stale render
  artifacts (`_cache/`, `*_files/`, `.quarto/`) went into project source; the build
  failed and **cleared published output on the way down**, with no rollback to the
  last good render. Restore in flight to last good source rev `3f35c92b9a4c…`.
- **My open action:** confirm independently when the book serves again —
  `page-info.json` 200 with three entries, each page returning content. The PM
  explicitly asked that this come from me rather than from them or the agent who
  broke it. Watch `b4m6cclzn` is running.
- Committed but deliberately NOT deployed: `3e1cab370` (401 → visible error
  instead of a blank book — this is my D4) and `67ecf5422`.

## 21:05Z — VISUAL PROOF, the thing Skip demanded

Screenshots taken through `playwright-cli -s=shared` (see tooling note below).

- **🔴 `qtm285-hw-minus-1` renders BLANK.**
  `.playwright-cli/page-2026-08-28T21-03-08-825Z.png` — empty canvas.
  DOM: **1 `.tl-shape`, 1×1 px, empty innerHTML.** `page-info.json` declares
  `800×1000`. Not off-camera; the shape is collapsed to nothing.
- **✅ `qtm285-lecture-1` renders correctly.**
  `.playwright-cli/page-2026-08-28T21-03-59-011Z.png` — "Lecture 1 / Introduction",
  page 1/18, QR, nav arrows. DOM: 8 shapes, six at 1076×834 with content.
- **So the render path works.** The failure is specific to `qtm285-hw-minus-1`.

**`FetchAsync N/M pages rendered` is NOT a render signal.** `src/editorSetup.ts:339`
— it counts the **text-selection overlay**, and its own comment says so: *"not
needed for visual rendering"*. `qtm285-lecture-1` reports `0/18` **and renders
fine**. I raised a false alarm off that line; do not use it to judge blankness.
`page-N.svg` and `toc.json` 404 on every project on the box, working ones
included — it is not a discriminator either.

**TOOLING, and it is why nobody could look at a page all day:**
`tlda-dev pw` warns *"could not locate playwright-cli tab-select implementation"*
and forwards every verb to an `about:blank` marker tab while `goto` navigates a
different one. **`tab-select` exists and works.** Bypass the pool:

```sh
node_modules/.bin/playwright-cli -s=shared tab-list
node_modules/.bin/playwright-cli -s=shared tab-select <n>
node_modules/.bin/playwright-cli -s=shared screenshot
node_modules/.bin/playwright-cli -s=shared eval "() => …"
```

The detection bug is in `cli/lib/pw.mjs`. Fleet shapes written by my two loads:
believed **zero** — `qtm285-lecture-1` showed the *"Set up your workspace"* prompt
rather than an applied layout, and none of its 8 shapes are fleet panels.

## 21:23Z — the book CRASHES, and it is Skip's 13:27 crash

`.playwright-cli/page-2026-08-28T21-23-03-841Z.png` — `/?project=qtm285-book`
shows a tldraw crash dialog, **not** a blank canvas:

> Something went wrong · Please refresh your browser · …you may need to reset the
> tldraw data stored on your device · **Note: Resetting will erase your current
> project and any unsaved work.** · `Show details` · **`Reset data`** · `Refresh Page`

**A student on the Continue link is offered a button that erases their work.**
I did not click it.

**Causal chain, from that load's console:**

```
404 — /docs/qtm285-book/page-info.json
Found undefined HTML pages
HTML document ready (undefined pages, 0 TLDraw pages)
TypeError: Cannot read properties of undefined (reading 'bounds')
```

That TypeError is **verbatim what Skip pasted at 13:27:48 today**. His lunchtime
crash and this are one bug: the missing status check (D4).

**`3e1cab370` fixes it — I read the diff.** The guard is `if (!response.ok)`,
general rather than 401-specific, plus an `Array.isArray` check. Deploying it
turns the data-erasing crash dialog into a readable error, for **any** project
whose output goes missing.

**Opening the viewer does NOT trigger a build** (PM's hypothesis, disproven):
`lastBuild`, `buildStatus`, `acceptSeq` and `page-info` all unchanged across the
open. `acceptSeq` is now 32 with `buildStatus: error` — pushes land, builds fail.

**Criteria 1, 4, 5 all PASS, confirmed visually:**
- reg flow → `.playwright-cli/page-2026-08-28T21-20-43-612Z.png`, Continue points
  at `project=qtm285-book` ✅
- gradebook panel → `.playwright-cli/page-2026-08-28T21-21-44-181Z.png`, shows
  `advocate-check-1 · ungraded · 3:57:46 PM` ✅
- photo round trip ✅ (byte-for-byte earlier)

## 21:35Z — the discriminator: `source` blocks in page-info (6/6, tested)

**A project renders iff its page-info entries carry a `source` block** — and
`toc.json` presence agrees on all six, so they are two faces of one missing
build step.

| project | entries w/ `source` | `toc.json` | renders |
|---|---|---|---|
| `qtm285-lecture-1` | 18/18 | 200 | ✅ seen |
| `qtm285-slides` | 18/18 | 200 | — |
| `pic-install` | 1/1 | 200 | — |
| `deploy-probe` | 1/1 | 200 | — |
| `qtm285-hw-minus-1` | **0/1** | **404** | ❌ 1×1 empty, seen |
| `pic-schedule` | **0/1** | **404** | ❌ 1×1 empty, seen |

**I tested this in the direction that could kill it:** opened `pic-schedule`, the
*other* no-source project, predicting blank. It is blank — 1 shape, 1×1, empty,
panel reads "No headings found". Same signature as `qtm285-hw-minus-1`.

**Verification order when the book returns** (PM's, step 2 is this lead):
1. `page-info.json` 200 with three entries — necessary, **not sufficient**
2. **each entry carries `source`** (`format: qmd`, chapter `.qmd` path), vs
   `qtm285-lecture-1` as control
3. each page returns real content
4. open it, with `qtm285-lecture-1` alongside, and say what a person sees

**Prediction to be held to:** three entries *with* source → renders; *without* →
200 + three pages + blank canvas, and every HTTP check we used tonight calls that
success.

**Bigger than tonight:** `pic-schedule` has been in this state since **2026-08-13**
and nobody noticed, because every HTTP signal on it is green. The build step that
writes `source`/`toc.json` has been silently skipping projects for two weeks.

## Superseded: the Continue re-check (done — passed)

At 16:0x the box served `gitSha c09e3943d` — **the old bundle**. Read out of
`assets/index-BfWOAdpN.js` (named by `index.html`), the registration component is:

```js
const e = ….get("course") || "qtm285"
f = o ? (…, g.searchParams.set("project", e), …) : null
```

No `get("project")` anywhere; `project` is set from the **course**; the ternary is
gated on the registration alone. So Continue targets `project=qtm285`, and there
is no project of that bare name on the box → 404, exactly as Skip hit it.

**Do not call Continue broken until the new bundle is confirmed loaded.** The
check: re-fetch the bundle named by `index.html` and look at the same window —

- old / not landed: `set("project", e)`, `e` from `get("course")`
- landed: a distinct `get("project")`, ternary gated on it

A server `gitSha` is not proof; read the bundle.

## Watch

- Subscription **#92611 `from:skip` (immediate)** — verified present via
  `subscription(operation: "list")`. Last Skip event read: **15:36:15 EDT**.
- Still to verify when the PM delivers: D1/D2/D3 fixes, and the decoupling
  proposal (findings 2 established both mechanisms already exist —
  `cli/lib/classroom-render.mjs` renders one chapter, `tlda project book` groups
  independent projects; a proposal needing a full book build is wrong on facts).
