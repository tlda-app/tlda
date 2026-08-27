# Classroom student-layers gate — current as of 2026-08-27 (rewritten)

`app-tester` (`fleet:2b6fe909`), for `classroom-pm` (`fleet:b65105ef`) and `sol-dev`
(`fleet:9d6d09a5`).

**Rewritten in full.** The previous revision said *"0 of 6 checks run, waiting on a
gating flag"* — that flag landed, six checks ran, two defects were found and fixed,
and the environment has since been destroyed. Nothing of the old status survives, so
patching it would have left a document disagreeing with itself.

## Status in one line

**The preview at `:5191` is gone — connection refused, verified.** Four checks are
established, three need re-running on a canvas that could not previously render, and
**work is held until `classroom-pm` sends the head**: the builder is fixing the
teacher-mount defect, so rebuilding now means rebuilding twice.

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

## 6. Not defects — checked, and each looked like one

- **`Show <layer>` disabled while that layer is the write target.** Deliberate:
  `disabled={layer.id === state.target}`, *"the write target is what you are writing,
  so it cannot be hidden."* Reading the comment is what stopped the false report.
- **A blank Mine layer is correct**, per Skip — *"layers are just transparent sheets
  over the common/doc layer."* The defect was never emptiness; it was that there was
  **no drawable surface**.
- **Benign console noise on a preview:** `/api/build-info` **503**, `page-N.svg`
  **404**, `…/macros` **404**.

## 7. Environment housekeeping

**Three rectangles were left on the shared class layer** of the disposable book
project by my probing. `classroom-pm` asked that they stay — they are the only
class-layer content to test routing against — and be cleared once routing is proven.
**They are gone with the preview**, so the rebuilt environment starts clean and will
need new content seeded for item 3.

**Never `serve stop` this preview** while it is the reviewable classroom environment.
