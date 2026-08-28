# The advocate's record — classroom recovery, 2026-08-28 {#advocate-record}

Written by `classroom-advocate` (`fleet:22de6a5b`), the independent advocate Skip
asked for at 15:31:24. Everything here I measured on the live public box myself.
Where I was wrong, it says so and says how I found out.

**A measurement is a timestamp, not a state.** Every row carries its time. Re-run
before leaning on any of it.

---

## 1. The five criteria, as of 22:00Z

| # | criterion | state | evidence |
|---|---|---|---|
| 1 | public enrollment registers a student, Continue opens the book | **PASSES** | registered through the real form in a browser; `Continue to class` present, `href` carries `project=qtm285-book`. `page-2026-08-28T21-20-43-612Z.png` |
| 2 | book visibly renders Intro → HW−1 → HW0 | **FAILS** | serves perfectly, draws nothing. `page-2026-08-28T21-45-51-756Z.png` |
| 3 | HW−1 setup/photo/template/Submit | **PASSES** (PM closed it) | submit wire proven by me; handout download closed by the PM |
| 4 | student photo → receipt | **PASSES** | upload 200 → receipt → project built in 6 s → **70 bytes in, 70 bytes out** |
| 5 | instructor list shows the submission | **PASSES** | panel renders the rows. `page-2026-08-28T21-21-44-181Z.png` |

**Criterion 2 is the only one open, and it is not a build problem.** The bytes are
correct and served; the canvas does not draw them.

## 2. The render defect — the open one

**Five projects opened in a real browser. Only the slide deck renders.**

| project | shapes drawn | renders |
|---|---|---|
| `qtm285-lecture-1` — slide deck (`slideIndex`/`group`/`groupIndex`) | 8 @ 1076×834, real content | ✅ |
| `qtm285-book` | **0 document shapes** | ❌ |
| `qtm285-hw-minus-1` | **0 document shapes** | ❌ |
| `pic-schedule` | 1 shape, 1×1 (not inspected by id) | ❌ |
| `pic-install` | 1 shape, 1×1 (not inspected by id) | ❌ |

**Correction to my own earlier shorthand, and it changes where to look.** I first
reported these as *"one shape, 1×1, empty"*, which reads as a document page
collapsed to nothing. Inspected by id on 2026-08-28 22:42Z, that shape is:

```json
{ "id": "shape:doc-version--sentinel", "type": "doc-version",
  "rect": {"w":1,"h":1,"x":200,"y":50}, "opacity": "0", "children": [], "innerHTML": 0 }
```

**A deliberate zero-opacity marker, not a document page.** Confirmed identical on
`qtm285-book` and `qtm285-hw-minus-1`; `.tl-page` count is **0** on both. I did not
re-inspect `pic-schedule` or `pic-install` at this depth.

**So the defect is that there are ZERO document page shapes, not squashed ones** —
do not go looking at geometry code on the strength of the 1×1.

**And the loader says it made them.** Same load:

```
Found 3 HTML pages
HTML document ready (3 pages, 3 TLDraw pages)
```

**The gap sits between the loader returning and anything reaching the editor, and
nothing throws.** No JavaScript exception on the load at all. The five console
errors are the three `page-N.svg` 404s (wrong asset name universally — they 404
identically on the rendering control) and one 403 on `/signal`, also present on the
control.

### Settled from the editor store, 22:44Z — no `html-page` shape was ever created

The DOM read above left one thing open: a shape could exist in the store and fail
to reach the DOM, which would be a different bug. It does not.

`window.__tldraw_editor__`, `qtm285-book`:

```js
currentPageShapes  → [ { id: "shape:doc-version--sentinel", type: "doc-version", w: 1, h: 1 } ]
pages              → [ { id: "page:page", name: "Page 1" } ]      // ONE page
store.allRecords() → exactly ONE shape record, the sentinel
```

`pic-install`, independent project, identical. **`allRecords()` covers every shape
in the store, not just the current page**, so nothing is hidden on another page.

**Three conclusions:**

1. **No `html-page` shape exists.** Not mis-sized, not hidden — never created. This
   killed a fix that was about to ship against `createShapes.ts:241` ("a room whose
   page shape was persisted with a collapsed height keeps it forever"), which needs
   a persisted page shape that does not exist.
2. **One tldraw page exists** while the loader logs three. Neither pages nor shapes
   were committed.
3. **`wm-project-layer-model` is absent too.** A working project on `testing` carries
   *two* permanent 1×1 fixtures; both `pic` projects have only `doc-version--sentinel`.
   A second missing thing, not a variant of the first.

**Two independent `pic` projects share the signature**, so it is the code path or
the box, not one room. A room reset fixes nothing; neither does anything pushed to
the project. Both boxes were current — `pic` `5784f5787`, `testing` `196dd5929`.

**Live question:** why `createHtmlPageShapes` commits nothing while the loader
reports three pages, silently, on `pic` and not on `testing`.

For `qtm285-book` this is true **with every upstream signal green**: `page-info.json`
200 with 3 entries, all 3 carrying `source` blocks, `toc.json` 200, pages serving
28,497 / 1,820 / 42,365 characters, and the console logging
`HTML document ready (3 pages, 3 TLDraw pages)`.

**A 1×1 shape is a geometry symptom, and slide decks take a different loader.**
Owner: `classroom-blank-401`. Note that `pic-schedule` has been in this state since
**2026-08-13**, which predates today's `measuredGeometryWrite.ts` commits — so the
cause may be older than them.

## 3. Standing defects with no owner

- **`pic-schedule` has been silently unrenderable since 2026-08-13.** Every HTTP
  signal on it is green. Nobody noticed for over two weeks. This is the exact class
  Skip described all day.
- **`tlda-dev pw` cannot reach the page it navigates.** It warns *"could not locate
  playwright-cli tab-select implementation"*, then forwards every verb to an
  `about:blank` marker tab while `goto` navigates a different one. **`tab-select`
  exists and works.** The detection bug is in `cli/lib/pw.mjs`. **This is why
  nobody in the fleet could look at a page all day**, and it is most of how a day
  of HTTP-green reports went unchecked. Workaround:

  ```sh
  node_modules/.bin/playwright-cli -s=shared tab-list
  node_modules/.bin/playwright-cli -s=shared tab-select <n>
  node_modules/.bin/playwright-cli -s=shared screenshot
  node_modules/.bin/playwright-cli -s=shared eval "() => …"
  ```
- **`tlda build` is documented and does not exist.** `cli/tlda.mjs:221` advertises
  *"Trigger a rebuild without pushing files"*; there is no `cmdBuild` and no
  dispatcher case. Belongs in `docs/naming-errata.md`.
- **A failed build used to empty published output** with no rollback — fixed
  tonight by `cb1a94beb`, recorded because it is what turned a content mistake
  into a two-hour outage.
- **`tlda project push` mirrors the directory, not the tracked tree**, so untracked
  files reach a live project's source. That is what broke the book at 20:44Z.
- **The registration heading shows the course *id*** (`qtm285`) where the gradebook
  correctly shows the *title* (`QTM 285`). One word, first screen sixty students see.

## 4. Instruments that lied, and the check for each

**This is the most reusable part of tonight.** Every one of these returned an
answer, and the answer was to a question nobody asked.

| instrument | what it looked like | what it actually said |
|---|---|---|
| `[FetchAsync] N/M pages rendered` | the page drew M pages | **the text-selection overlay.** `src/editorSetup.ts:339` says so in a comment. A project reporting `0/18` renders **fine** |
| `page-N.svg` 404 | the render is broken | **that name never exists.** `server/lib/ensure.mjs:17` — the real asset is `<texBase>-page-N.svg`. 404s identically on working and broken projects |
| `buildStatus: success` | the build succeeded | reflects the **source-revision lifecycle**, not a render. Reached `success` with `lastBuild` unmoved and nothing served |
| `pages: 3` | three pages exist | a count of a render that had been **deleted** |
| `page-info.json` 200 + right entry count | the document is fine | **necessary, not sufficient.** The book had this and drew nothing |
| a project record read via `/api/projects/<name>` | current state | reads healthy while the surface serves 404 |

**The rule that would have caught all six: fetch the artifact, or open the page.
A status field on this box is not evidence about a surface.**

## 5. Two things I got wrong, and how they were caught

**Both were mine, both were caught by me, neither cost anything — but only because
they were caught.**

**(a) I reported the book blank from a log line.** I read
`[FetchAsync] 0/1 pages rendered` and asserted HW−1 was blank without checking what
the counter counted. I retracted when the code showed it was the text layer. Then a
screenshot showed it *was* blank — right conclusion, wrong reasoning, and I had told
the PM not to send a link on the strength of the wrong reasoning.

**(b) I offered a correlation as an acceptance gate.** I found that every project
whose `page-info` entries lacked a `source` block rendered blank — 6/6, and I
tested it by predicting `pic-schedule` would be blank, which it was. **But I only
ever tested in the confirming direction.** The PM built the acceptance test on it.
When the book came back with 3/3 `source` blocks and still drew nothing, I opened
`pic-install` — source block present, `toc.json` 200 — and it was blank too. **The
lead was dead.** Had I let it stand, we would have shipped a book that serves
perfectly and shows a student nothing, and called it done.

**The lesson, stated once: a correlation is not a gate until it has been tested in
the direction that would falsify it — a *working* case without the property, not
another broken case with it.**

## 6. What the deploy fixed, verified by behaviour

`3e1cab370` — *a refused document load says so instead of rendering blank*.

**Before**, a project whose output was missing showed a tldraw crash dialog:

> Something went wrong · …you may need to reset the tldraw data stored on your
> device · **Note: Resetting will erase your current project and any unsaved
> work.** · `Show details` · **`Reset data`** · `Refresh Page`

A student on the Continue link was one red button from erasing their own work. The
crash underneath it was `TypeError: Cannot read properties of undefined (reading
'bounds')` — **verbatim what Skip pasted at 13:27:48 today.**

**After**, verified on the live box at 22:00Z by loading a project that does not
exist, so the fetch really 404s:

```
404
Document not found
Document "no-such-project-advocate" not found.
← All documents
```

**The guard fires.** Not read from the bundle — watched.

**`pic-schedule` is not a test of this guard**, contrary to what was suggested: its
`page-info.json` returns **200**, so `!response.ok` cannot fire. It is blank for the
canvas reason in §2, which is a different defect.

## 7. Method — how to actually check a page here

1. **Public box is `tlda-pic`.** `tlda-pic-dev` has no public A record and
   `fly.pic-dev.toml` has no `TS_FUNNEL`. Two independent sources agree. Work
   verified on `pic-dev` is a measurement of nobody.
2. **The student link is the `/auth/login` form**, and every parameter is
   load-bearing:
   `…/auth/login?token=<READ>&redirect=%2F%3Fworkspace%3Dclassroom-register%26course%3Dqtm285%26project%3Dqtm285-book`
3. **Read token → the book. Enrollment token → the classroom. RW → the instructor
   view**, which hides what a student hits.
4. **Open the page.** Use the `playwright-cli -s=shared` recipe in §3. Count
   `.tl-shape` elements and their sizes — a single 1×1 empty shape is the blank
   signature.
5. **Keep `qtm285-lecture-1` open alongside as the control.** It renders. It is the
   only unambiguous answer anyone got tonight, and it is now the standing check.

## 8. Housekeeping

Test students I created in the real `qtm285`, per Skip's ruling that test students
go in the real course: `advocate-check-1` (submitted, with photo), `advocate-check-2`,
`advocate-check-3`.

**Fleet shapes written across every browser session tonight: zero.** One stable
identity throughout, delta reported as agreed.

**Nothing in this operation was sent to Skip by me.**
