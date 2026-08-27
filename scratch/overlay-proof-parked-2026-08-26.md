# Classroom student-layers gate — current as of 2026-08-27 (rewritten)

`app-tester` (`fleet:2b6fe909`), for `classroom-pm` (`fleet:b65105ef`) and `sol-dev`
(`fleet:9d6d09a5`).

**Rewritten in full.** The previous revision said *"0 of 6 checks run, waiting on a
gating flag"* — that flag landed, six checks ran, two defects were found and fixed,
and the environment has since been destroyed. Nothing of the old status survives, so
patching it would have left a document disagreeing with itself.

## Status in one line

**6/6 pass on `ae0dd16fb`** (branch `classroom-student-overlay`), against a gated
fixture on `:5190`. **The branch has not merged** — it is 22 ahead of `main` and 15
behind, so **this result goes stale at the merge** and 2 and 4 need re-running on the
merged head.

## Results, 2026-08-27

| # | check | result |
|---|---|---|
| 1 | control exists and is scoped | PASS |
| 2 | **the tool never decides the destination** | **PASS — fully exercised** |
| 3 | visibility independent of write target | PASS |
| 4 | move to layer | PASS, position preserved |
| 5 | teacher | PASS |
| 6 | isolation | **PASS with drawn strokes** — supersedes the editor-API result |

**Check 2, the property Skip corrected the design for, executed for the first time:**

| tool | target | Mine | Class |
|---|---|---|---|
| pen | Class | 0 | 12 → **13** |
| pen | Mine | 0 → **1** | 13 |
| highlighter | Mine | 1 → **3** | 13 |
| highlighter | Class | 3 | 13 → **15** |
| eraser | Mine | 3 → **2** | 15 |

Counts are DOM nodes — **a highlighter stroke renders as two**, which is why those
rows move by 2. The direction is the result, not the magnitude.

**Check 4**: marquee-select → pill `Move 1` → `Move to Class`; Mine 1→0, Class 15→17,
mark at **`664, 684 · 197×67` before and after** — identical rect, and **visible to B
at the same coordinates**.

**Check 5's control is the load-bearing part**: teacher on A shows **1** mark, on B
shows **0**. Different counts per student prove it reads *that student's* layer rather
than rendering a constant — a single number would have passed and proved nothing.

**Not tested, deliberately left open:** the `queueMicrotask` deferral in `mirror()`
puts camera mirroring one microtask behind the book. **No lag was observed and that is
not evidence** — short Playwright drags are not a fast pan. It needs a trackpad and a
human.

## The three faults this took, in order

Each was hidden behind the one before it, which is why the feature was untestable for
two days.

| # | fault | fixed at |
|---|---|---|
| 1 | overlay returned `null` until `synced-remote`, so a reconnect disposed its editor | `88e3c6455` |
| 2 | overlay passed **no `licenseKey`** — tldraw renders a container and stops | `3869d3abe` |
| 3 | both mirroring reactors **read the sink inside the reactive function**, so a write during capture left `undefined` in `parents` | `ae0dd16fb` |

**Fault 3 is the one worth understanding.** `haveParentsChanged` walks a reactor's
`parents` and dereferences every slot; `startCapturingParents` does **not** clear
`child.parents`, and only `stopCapturingParents` truncates it — so **for the duration
of a reaction the array is half-updated**, and anything that walks it mid-capture reads
a slot in flux. A reactor that writes what it reads triggers exactly that walk. The fix
defers the write to a `queueMicrotask` so it runs outside the capture frame.

**Diagnosis credit where it changed the search:** the boundary swallowed the stack, and
hooking `console.error` before triggering and stashing to `sessionStorage` recovered it.
The throwing frame was `haveParentsChanged`, **not** any of the four `Editor.js` camera
call sites — and the offset in the error message was `updateInstanceState`, not a camera
method. Everyone had been reasoning from a message that named the receiver, not the
caller.

## 1. Established — do not re-derive

Held by `classroom-pm` as settled unless something contradicts them.

| # | check | result |
|---|---|---|
| 1 | control exists and is scoped | student sees the **Class** pill; unenrolled reader sees **no pill**, book unchanged |
| 3 | visibility independent of write target | both halves; hide/un-hide loses nothing |
| 5 | teacher, in part | flick A→B→A **without remount**; teacher **cannot** draw into a student layer |
| 6 | isolation | **room isolation only — via editor-API marks, not drawn strokes** |

**That check-6 caveat travels with the result.** It has been stated upward twice. If
it is ever repeated as "isolation is proven", say so — the drawn-stroke property is
exactly what the canvas fault prevented anyone from closing.

**Check 5's evidence for "no remount" is a marker set on `window`** before clicking
`→`, still present after. That is the cheap form of the check and it is conclusive.

## 2. What the rebuilt environment must prove, in this order

1. **Teacher view mounts with RW + `?course=` and no classroom token** — the defect
   being fixed now.
2. **The private canvas actually renders** — `.tl-canvas` present *inside* the
   overlay container, not merely a container. The licence-key fix has never been
   seen in a browser.
3. **Real pointer strokes route by selected target** — draw to Class, B sees it;
   draw to Mine, B does not; switch and repeat; **then pen, highlighter and eraser
   each in turn.** Never once exercised. This is what Skip corrected the design for.
4. **Move to layer** — draw on Mine, select, move to Class; position holds, B sees it.
5. **Teacher sees Student A's marks.**

## 3. The two defects found, and their fixes

| defect | symptom | fixed at |
|---|---|---|
| overlay disposed its own editor | selecting **Mine** threw `Cannot read properties of undefined (reading '__unsafe__getWithoutCapture')`; overlay **and** the pill left the page, reload the only way back | `88e3c6455` |
| overlay passed no `licenseKey` | tldraw renders its container and stops — real `tl-container`, correct size, healthy store, **no `.tl-canvas`** | `3869d3abe` |

**The crash was timing-dependent (124.7s, 89.6s) because it needed a reconnect
first**, not because selecting Mine was slow. Pre-fix the component returned `null`
until `synced-remote`, so any reconnect unmounted the canvas and disposed the editor
while the camera reactor kept writing to it.

**Verified fixed:** two fresh loads at 90s and 150s dwell, four Class↔Mine switches,
and `getWithoutCapture` counted **2 in the pre-fix log, 0 in three post-fix logs** —
with the pre-fix log used as the positive control for the grep.

**`3869d3abe` also gave the overlay the app's tool set**, which it never had. So a
tool that previously did nothing may now behave, and that is part of what item 3
above is testing.

**Open teacher-mount defect (found here, being fixed):** identity is fetched only
when the URL carries `classroomToken` —

```js
if (!new URLSearchParams(window.location.search).get('classroomToken')) return
```

An instructor authenticates with the **RW bearer token** and has no enrolment token,
so `identity` stays null and `TeacherStudentOverlay` never mounts. **No error, no
surface — silently absent reads as never built.** Adding any classroom token mounts
it at once (`← Student A · 1 of 2 →`), because the rw level short-circuits to
instructor. `/api/classroom/me` already returns `{"role":"instructor"}` for the RW
token, so identity should follow the credential, not a query parameter.

## 4. Rig facts — each of these cost a wrong reading

- **The overlay mounts only inside `BookViewer`**, which needs `format: "book"` with
  a **non-empty `members`** array. A single-doc project renders the ordinary canvas
  with no overlay and no control. **I nearly filed that as "no pill".** Open the
  **book** project, not the member doc.
- **The teacher view also needs `?course=`**, read from the URL with **no fallback**,
  deliberately — absent means no roster and no overlay.
- **`--gated` is genuinely in the shared `tlda-dev serve --help`** (checked
  2026-08-27, not merely accepted silently). **Still confirm an unauthenticated
  request returns 401** before believing a preview is gated.
- **The built-in seeder cannot seed a gated preview** — it posts unauthenticated and
  reports *"scratch project not seeded"*. Create the project with the RW token.
- **`serve stop` discards the whole sandbox** — projects, classroom DB, config. Only
  `daemon-cfg/` survives. Config must be written and tokens printed **at every start**.
- **Rebuilding the client is enough to ship a fix; no restart needed.** Assets are
  served from `dist/`, so `npx vite build` in the worktree updates the running
  preview and **the sandbox survives**. Confirm by comparing the bundle name in
  `dist/index.html` against what the server returns.

## 5. Instrument traps — every one of these produced a false or empty reading

- **A second fault can certify the first one fixed.** The crash fix was verified on
  2026-08-26 by two fresh loads at 90s and 150s dwell, four target switches, and a
  positive-controlled grep returning **0**. **All of it was worthless**: that build
  had the licence-key fault, so the overlay had **no canvas and therefore no live
  editor to dispose**. The crash had nothing to fire on. The moment the canvas
  rendered, it came back on the first click. **The green measured the absence of a
  canvas, not the presence of a fix** — and every element of that verification was
  individually sound. **Before believing a fix, establish that the thing it repairs
  is capable of failing in the build you tested.**

- **Synthetic `PointerEvent`s do not drive this tldraw.** Dispatching a full
  down/move/up sequence creates nothing, with or without `setPointerCapture` stubbed.
  Do not report a drawing result from them.
- **`playwright-cli` has no coordinate mouse.** `drag` takes `startTarget`/`endTarget`
  **elements**, not points. Verbs are element-based: `click`, `drag`, `hover`,
  `check`/`uncheck`, `fill`, `find`, `eval`.
- **`check`/`uncheck` work where a synthetic `.click()` on the input silently does
  not.** A direct `.click()` left the box `checked: true` and I nearly filed
  "the toggle is inert".
- **The React fiber walk climbs past the overlay and returns the *class* editor.**
  Tell them apart by shape count, not by which container you started from — and a
  shape you create through it lands on the class layer.
- **The pw console log is shared across every tab in the pooled browser**, including
  other agents'. Entries for `play.google.com`, `mistral.ai`, `appleid.apple.com` are
  not your page. **Do not read or report them.**
- **`ls -t` on `.playwright-cli/` returns a months-old log**; it misled me twice.
  Take the path the `pw console` output names, or `find -mmin -N`.
- **Always positive-control a grep for an error string** against a log known to
  contain it. `0` from a wrong path and `0` from a fixed bug look identical.
- **A bundle hash does not identify a commit.** `6404d0106` built to
  `index-BNhVb3Sp.js` once and `index-92XFiDT2.js` later, from a **clean worktree at
  the same sha** — the build is not byte-reproducible here. Comparing `dist/index.html`
  against the server proves the server **picked up your build**; it does not prove
  *which commit*. **Identify by a string only one build contains** — e.g.
  `grep -c "follow book tool selection"` is 1 on the real head and 0 on the
  tool-follow probe. Same distinction as ancestry-versus-content on a cherry-picked
  commit.
- **Three controls turn an absence into a result**, and all three are needed: the
  **trigger fired** (so it isn't a crash avoided by never reaching the state), the
  **instrument is alive** (fire a synthetic error through your own hook afterwards),
  and the **grep is positive-controlled** against a log known to contain the string.

## 6. Not defects — checked, and each looked like one

- **`Show <layer>` disabled while that layer is the write target.** Deliberate:
  `disabled={layer.id === state.target}`, *"the write target is what you are writing,
  so it cannot be hidden."* Reading the comment is what stopped the false report.
- **A blank Mine layer is correct**, per Skip — *"layers are just transparent sheets
  over the common/doc layer."* The defect was never emptiness; it was that there was
  **no drawable surface**.
- **Benign console noise on a preview:** `/api/build-info` **503**, `page-N.svg`
  **404**, `…/macros` **404**.

## 7. The fixture — do not clear it

Gated preview on **`:5190`**, worktree `~/worktrees/app-tester-overlay-proof`. Tokens
are printed at every start and are in the launch log, not in this file.

| | |
|---|---|
| course | `overlay-proof`, assignment `overlay-hw` |
| students | `stu-a`/`tok-a`, `stu-b`/`tok-b` |
| book | **`overlay-class`** (`format: "book"`, members `["overlay-doc"]`) |
| member doc | `overlay-doc`, pages 1, build success |
| content | A's private stroke, B's layer empty, **17 class-layer shapes** incl. the moved one |

**This is a reviewable classroom environment** — the thing Skip asked for and we could
not offer him. **Do not clear the content**: it is what makes it look like a class
rather than an empty demo. **Never `serve stop`** — that discards projects, the
classroom DB and config, and rebuilding it is roughly an hour.

**A code fix does not cost the fixture.** Check out the head, `npx vite build` in the
worktree, and the running preview serves it — no restart, nothing lost. Verify by
content, per §5.

## 8. Next action, when the branch merges

`classroom-student-overlay` is **22 ahead of `main` and 15 behind**. The 6/6 above is
against the unmerged branch, so **it goes stale at the merge**.

**The gate is settled at 2, 4 and 5** — `sol-dev`, 2026-08-27, superseding an earlier
2-and-4 instruction. For 5: **teacher mount by RW credential, and the A=1/B=0 flick
control.**

Why those three and not all six:

- **2 and 4** exercise the reactive path all three faults lived in.
- **5** is the only check that has **already failed once**, and it failed for a reason
  nothing in the reactive path predicts — a `classroomToken` gate on the identity
  fetch. Its mount depends on `/api/classroom/me` and `BookViewer`'s identity effect,
  and 15 commits are enough to disturb `unified-server.mjs`.
- **1 and 3 are excluded on coverage, not economy:** they are pure client-side layer
  state with no server or reactive surface between them and the pill, so those commits
  cannot reach them without also breaking 2 — which would catch it.
- **6 is largely re-established by 4**: the moved mark visible to B at A's coordinates
  is already a cross-user read of the class room.

**The A=1/B=0 control is the load-bearing half of 5** and must be re-run with it. A
single count would pass while proving nothing.

Do not merge or deploy from here; that is not this agent's call.

**Probe branch `classroom-overlay-toolfollow-probe` (`196194a5f`) is finished with** —
confirmed 2026-08-27 that no worktree holds it, it is not in this fixture's history,
and the served bundle contains the tool-follow reactor and not the probe's
`DIAGNOSTIC` marker. **Check the exact branch name**: a substring grep for `probe`
matches sixteen unrelated worktrees here.
