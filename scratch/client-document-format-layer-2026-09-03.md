# The client-side document format layer

`rc-read-view`, 2026-09-03. Read-only; nothing edited, committed, or branched.

## Summary {#summary}

Read against **`main`, tip `4490e53ac`** — not the shared checkout, which sits on
`project-airplane-mode` and **does not contain `src/airplaneMode.ts` at all**.

**The headline, and it reorganises the answer: `format` is not one field. It is
five fields with the same name, and the code branches on all five as though they
were one.** Each loader **restamps** `format` onto the document it returns, so on
the loaded document only `html`, `slides`, `png` and `undefined` are reachable —
a `markdown` project's document says `html`, a LaTeX project's document says
**nothing at all**. LaTeX is selected everywhere by falling through, never by
being named. Three declared unions still advertise four values the field cannot
hold.

The three deliverables are in
`scratch/client-document-format-layer-2026-09-03.md`: **§1** every branch site
(~40 rows, marked live / dead / vestigial, grouped by carrier), **§2** the path
per kind end to end, **§3** the count for a new kind — **~9 sites to render, ~25
to be correct, across ~15 files and 3 copies of the union type**.

Three things worth your attention beyond what was asked:

- **`png` is a client-only format.** No server code sets or reads it; the client
  union advertises a value the API cannot return. Verified with a positive control.
- **`diff` does not exist.** It is a `switch` case and two comments — including
  one in `shared/document-formats.mjs`, the file that is this layer's design record.
- **The newest commit touching three of these files is a revert.** `281e72172`,
  `Revert "Merge document format architecture"`, 104 files, −1694 lines, which
  deleted a `documentLoaderRegistry` and its test. **It records no reason.** So
  §3 measures a restored shape, not an unexamined one — which I think changes how
  you read the number.

**Nothing was run.** No server, no browser, no rendered document — per the brief
this was a read. §"What I did not establish" lists the four gaps.

## Scope and how it was measured {#scope}

**Tree read: `main`, tip `4490e53ac`.** The shared checkout at `/Users/skip/work/tlda`
is on `project-airplane-mode` (`8f72658d9`), which **does not contain
`src/airplaneMode.ts` at all** — that file is on `main` only. So a grep in the
shared checkout is not a grep of the shipped client, exactly as AGENTS.md
§"Prove the wire" warns. I exported `git archive main` to a scratch tree and read
that, so every claim below is about `main` and nothing about the branch.

Greps ran with positive controls. One produced a false zero on the way: an
unquoted `--include=*.ts` is glob-eaten by zsh (`no matches found`), reported as
`0` references to `format` in a tree that has 216. That is the AGENTS.md
false-negative class, caught by the control, not by care.

**Where I could not establish something I say so, distinctly from "nothing there."**

---

## 0. The finding that reorganises the rest {#restamping}

Before the list is readable, one fact has to be on the table, because it decides
which rows are live and which are dead.

**`format` is not one field. It is five fields with the same name, carrying
different value sets, and the code branches on all five as though they were one.**

| # | carrier | where it is defined | values actually reachable |
|---|---|---|---|
| 1 | `DocConfig.format` | `src/App.tsx`, from `GET /api/projects/:name` | `svg` `png`* `html` `book` `slides` `markdown` `qmd` |
| 2 | `SvgDocument.format` — **the loaded document** | `src/loaders/types.ts`, stamped by the loader | **`html` · `slides` · `png` · `undefined`** |
| 3 | `ProjectContextValue.format` | `src/PanelContext.ts`, `= document.format` | same as (2) |
| 4 | `ProjectDocument.format` | per-root row in the `/api/projects/:name` `documents[]` array | `markdown`, or the root's format |
| 5 | `doc-arrived` SSE payload `format` | `server/lib/build-runner.mjs` → `useDocAutoOpen` | the raw project format |

\* `png` is never sent by the server — see §"png is a client-only format".

**The restamp.** `src/App.tsx`'s dispatch calls `viewFormat(config)` and hands
off to a loader. Each loader **writes its own `format` onto the object it
returns**, discarding the config's:

- `createHtmlDocumentFromPageInfo` / `loadHtmlDocument` → `format: 'html'`, unconditionally
- `loadSlidesDocument` → `format: 'slides'`
- `loadImageDocument` → `format: 'png'`
- `createSvgDocumentLayout` → **no `format` key at all** — the field is `undefined`

So after loading:

- a **`markdown`** project's document has `format === 'html'`
- a **`qmd`** project's document has `format === 'html'` or `'slides'`
- an **`svg`** project's document has `format === undefined`, **never `'svg'`**

**Consequence.** Every site that branches on the *loaded document* can only ever
see `html`, `slides`, `png`, `undefined`. Tests against `'markdown'`, `'qmd'` or
`'svg'` on that carrier are unreachable. Both `ProjectContextValue.format` and
`SvgDocument.format` still **declare** the full seven-value union, so the type
advertises four values it cannot hold, and the negative tests
(`!HTML_PAGE_FORMATS.has(...)`) work for LaTeX only because `undefined || ''`
is not in the set — they are right by absence, not by naming.

I want to be exact about the limit of that claim: it is established for documents
loaded through the `App.tsx` and `BookViewer.tsx` dispatches, which are the two
entry points I traced end to end. I did not exhaustively prove no other code
path constructs an `SvgDocument` with a different `format`.

---

## 1. Every client-side branch site {#branch-sites}

Complete for `main`. Grouped by which carrier the site reads, because that is
what decides whether the row is live. **L** = live, **D** = dead (condition
cannot be true on that carrier), **V** = vestigial (true but redundant).

### 1a. The shared sets and `viewFormat` — `shared/document-formats.mjs` {#sites-shared}

Last touched by `281e72172`, which is a **revert** (see §5).

| site | is | what it does | |
|---|---|---|---|
| `FORMATS_WITH_OWN_PAGE_INFO` | the set `{markdown, html, slides, qmd}` | declares whose `page-info.json` is the document's own page listing rather than the project's markdown parts listing | L |
| `HTML_PAGE_FORMATS` | the set `{html, markdown, qmd}` | triple-duty: pages-are-iframes, has-no-synctex/proof, source-is-line-addressed | L |
| `viewFormat(project)` | function | returns `project.format`, except `qmd` → `project.renderedFormat \|\| 'html'` | L |

The header comment naming the non-own-page-info formats as "svg, png, diff, …"
is stale on one term: **`diff` is not a project format anywhere in the tree** —
see §"diff exists in exactly one place".

### 1b. Sites reading the **config** (carrier 1) — all live {#sites-config}

| path | the site is | what it does | |
|---|---|---|---|
| `src/App.tsx` | the `DocConfig.format` union type declaration | enumerates `svg png html book slides markdown qmd`; the client's only written enumeration | L |
| `src/App.tsx` | the book branch in the project loader | `config.format === 'book'` → fetch the whole manifest and resolve members instead of loading a document | L |
| `src/App.tsx` | the book branch in the reload/refresh path | same test again, second site | L |
| `src/App.tsx` | **the main viewing dispatch** | `viewFormat(config)` → `html\|markdown`→HTML loader, `slides`→slides loader, `png`→image loader, else→SVG layout | L |
| `src/BookViewer.tsx` | **the book member viewing dispatch** | `variant \|\| viewFormat(member)` → `slides`→slides loader; else `HTML_PAGE_FORMATS.has(member.format)`→HTML loader; else→SVG layout | L |
| `src/BookViewer.tsx` | the airplane-mode member mapping | passes `member.renderedFormat \|\| member.format` — an **inlined `viewFormat`**, not a call | L |
| `src/panels/TocTab.tsx` | the book-member course-item typing | `viewFormat(member) === 'slides'` → mark the member a `deck` in the TOC | L |
| `src/panels/TocTab.tsx` | the airplane-mode project mapping, book arm | same inlined `renderedFormat \|\| format` as BookViewer | L |
| `src/airplaneMode.ts` | `offlineDocumentUrls` | `info.pageInfo?.length \|\| FORMATS_WITH_OWN_PAGE_INFO.has(...)` → cache the page-info URLs; else build `<texBase>-page-N.svg` from targets | L |
| `src/panels/ProjectTab.tsx` | `activateUnplaced`, carrier 4 | `document.format === 'svg'` → centre camera by target/page arithmetic rather than opening an HTML page | L |
| `src/panels/ProjectTab.tsx` | unplaced-document shape creation, carrier 4 | `format === 'svg'` ? `svg-page` : `html-page`, and `pageIndex: 0` only for svg | L |
| `src/hooks/useDocAutoOpen.ts` | the `doc-arrived` handler, carrier 5 — **five tests** | `format === 'markdown'` gates: fetching `page-info.json`; the page count; the per-page `y`; the shape type (`html-page` vs `svg-page`); and the props (`url` vs `pageIndex`). Also an early `if (format === 'markdown') return` | L |

### 1c. Sites reading the **loaded document** (carriers 2/3) {#sites-document}

| path | the site is | what it does | |
|---|---|---|---|
| `src/editorSetup.ts` | `refreshSvgProjectParts` guard | `FORMATS_WITH_OWN_PAGE_INFO.has(document.format)` → return, so a document that owns its page-info is not re-rendered a second time as "parts" | L |
| `src/editorSetup.ts` | `reloadPages`, deck arm | `format === 'slides'` → `reconcileSlideLayout` then the iframe reloader | L |
| `src/editorSetup.ts` | `reloadPages`, iframe arm | `HTML_PAGE_FORMATS.has(...)` → `reloadHtmlPages` | L |
| `src/editorSetup.ts` | `reloadPages`, image arm | `format === 'png'` → no-op reload | L |
| `src/editorSetup.ts` | initial shape creation, 4-way | HTML set→`createHtmlShapes`; `slides`→`createSlidesShapes`; `png`→`createImageShapes`; else→`createSvgShapes` | L |
| `src/editorSetup.ts` | the ribbon gate | `!== 'png' && !== 'html' && !== 'slides' && !== 'markdown'` → enable ribbon + eraser | V — the `'markdown'` clause is unreachable; `'html'` already covers it |
| `src/editorSetup.ts` | the camera-bounds mode | `format === 'slides'` → free camera within bounds, zoom-fits first slide | L |
| `src/SvgDocument.tsx` | presentation mode | `format === 'slides'` → camera-link broadcast, presenter/viewer role | L |
| `src/SvgDocument.tsx` | the `n`/`p` chapter shortcuts | `format !== 'html'` → return, so page-stepping keys exist only for multipage HTML | L |
| `src/SvgDocument.tsx` | source-map load gate | not-HTML and not `png`/`slides` → `sourceMap.load()` for hyperref/label navigation | L |
| `src/SvgDocument.tsx` | scrolly overlay + home tool | `getFormatConfig(document.format)` — see 1d | L |
| `src/DocumentPanel.tsx` | `isHtml` | `HTML_PAGE_FORMATS.has(doc?.format)` — drives HTML-specific panel affordances | L |
| `src/DocumentPanel.tsx` | the button-TOC gate | `doc?.format === 'slides' \|\| isPhone \|\| IS_TOUCH_DEVICE` → button TOC instead of hover TOC | L |
| `src/svgPageFetchPolicy.ts` | `fetchDocumentSvgPages` | HTML set **or** `png`/`slides` → return false, fetch no SVG pages | L |
| `src/annotationSourceAnchor.ts` | the synctex fallback gate | after the per-shape html-page test, `HTML_PAGE_FORMATS.has(...)` → return null (no anchor); else canvas→PDF→synctex | L |
| `src/hooks/useProofToggle.ts` | `hasProofInfo` | `basePath && !HTML_set && !png/slides` → the proof toggle exists at all | L |
| `src/hooks/useYjsSignals.ts` | `hasSynctex` | same predicate → load/refresh the synctex lookup and source map across rebuilds | L |
| `src/hooks/useYjsSignals.ts` | `hasMismatchedRender` | `slides` or HTML set → **always** report mismatch (reload on any version bump); else compare per-page render hashes | L |
| `src/panels/TocTab.tsx` | deck TOC fetch | `doc.format === 'slides'` → TOC from `page-info.json` titles, and **return** — no heading/outline path | L |
| `src/panels/TocTab.tsx` | deck TOC render | `doc?.format === 'slides' && slideTitles` → render the slide-title list | L |
| `src/panels/TocTab.tsx` | presenter-role hint | `doc?.format === 'slides'` → show the presenter/viewer toggle hint | L |
| `src/panels/SearchTab.tsx` | search-source gate | `ctx.format === 'slides'` → clear both indices and return: **no search in a deck** | L |
| `src/shapes/docViewTarget.ts` | `resolveDocViewTargetShapeId` | `format !== 'html'` → `''`, so a fleet doc-view pill resolves a target shape only for HTML | L |
| `src/shapes/FleetDocViewShape.tsx` | passes `doc?.format` into the above | the call site of that rule | L |
| `src/classroom/useMarkedExerciseHtmlAlignment.ts` | alignment gate | `format !== 'html' \|\| pages.length < 2` → return; the marked-exercise side-by-side | L |
| `src/livePerfProbe.ts` | telemetry stamp | `documentInfo.format \|\| 'svg'` — **the only place the string `svg` is ever materialised as a value** | L |

### 1d. `src/formatConfig.ts` — a sixth enumeration, easy to miss {#sites-formatconfig}

It never mentions `format`-the-field in a way the obvious greps catch, and it is
a full switch over the format space driving the **toolbar**:

| case | config | effect |
|---|---|---|
| `html` | `HTML_CONFIG` | HTML tool list, scrolly overlay **on**, navigation `pages`, browse bounces |
| `markdown` | `HTML_CONFIG` | **D** — unreachable on the loaded document |
| `qmd` | `HTML_CONFIG` | **D** — unreachable on the loaded document |
| `slides` | `SLIDES_CONFIG` | HTML tool list, overlay off, navigation `scroll`, browse bounces |
| `diff` | `DIFF_CONFIG` | **D** — `diff` is not a format anywhere (§"diff exists in exactly one place") |
| default | `SVG_CONFIG` | SVG tool list (adds `cluster`, `terminal`, `fleet-*`), overlay off, `scroll`, no bounce |

`png` reaches `default`, so a PNG document gets **the LaTeX toolbar**, including
tools whose backing data a PNG document does not have.

Consumers: `src/SvgDocument.tsx` (scrolly overlay, home tool),
`src/toolbar/FormatToolbar.tsx`, `src/toolbar/ToolbarComponents.tsx`.

---

## 2. The viewing path per kind, end to end {#per-kind}

### `svg` (LaTeX) {#kind-svg}
Fetch: `createSvgDocumentLayout` builds the layout immediately from
`config.targets[]`; page SVGs fetched async after mount; `…/api/projects/:name/macros`
fetched for preamble macros. Component: `createSvgShapes` → SVG page shapes.
Pages: **SVG**, not iframes. `page-info.json`: **not the document's** — it is the
project's markdown **parts** listing, read by `refreshSvgProjectParts` and
rendered as html-page shapes on their own TLDraw page.
Works: annotations ✓ · source anchoring ✓ (synctex) · proof toggle ✓ · TOC ✓
(headings/targets) · airplane mode ✓ (via `targets[]`) · ribbon ✓ · search ✓.
**Note:** `document.format` is `undefined` here, so this kind is selected
everywhere by *falling through*, never by being named.

### `markdown` {#kind-markdown}
Fetch: `config.pageInfo` if the config was fetched with `?include=page-info`,
else `GET {basePath}page-info.json`. Component: `createHtmlDocumentFromPageInfo`
→ `createHtmlShapes`. Pages: **iframes**, one TLDraw page per chapter, tab groups
laid out horizontally. `page-info.json`: **the document's own** page listing.
Restamped to `format: 'html'`.
Works: annotations ✓ · source anchoring ✓ but by a **different route** — the
per-shape `htmlPageAtCanvasPoint` test, which fires before the format test;
synctex path returns null · proof toggle ✗ · TOC ✓ (HTML TOC) · airplane mode ✓
· ribbon ✗ · search ✓ (HTML search index) · `n`/`p` ✓ (via the restamp to `html`).

### `html` {#kind-html}
Identical to `markdown` after load — same loader, same restamp, same shapes.
The only place they diverge is the config-carrier sites: `useDocAutoOpen` treats
`markdown` specially and `html` not at all, and `formatConfig` maps both to
`HTML_CONFIG`. **On the loaded document these two kinds are indistinguishable.**

### `qmd` {#kind-qmd}
The one kind whose build format and view format differ. `viewFormat()` reads
`renderedFormat` (`html` or `slides`, written by the qmd builder) and routes to
the HTML or slides loader accordingly; `format` stays `qmd` on the config so the
next rebuild still routes to quarto. After load it is **exactly** the `html` or
`slides` case — the `qmd` string does not survive into the document.
Works: whatever its `renderedFormat` case works, with one exception —
`useDocAutoOpen` (carrier 5) does **not** call `viewFormat`, so a `qmd` arriving
over SSE is treated as not-markdown → `svg-page` shapes with `pageIndex` props,
against a document that has no SVG pages.

### `slides` {#kind-slides}
Fetch: `loadSlidesDocument` → `page-info.json` for slide entries + deck layout.
Component: `createSlidesShapes`. Pages: **iframes**, one per slide, addressed by
reveal coordinates (`_tldaH`/`_tldaV`), laid out spatially rather than stacked.
`page-info.json`: **the document's own** slide listing (`title` per entry).
Reload: its own arm — `reconcileSlideLayout` (handles slide-count growth) then
the shared iframe reloader.
Works: annotations ✓ · source anchoring ✗ · proof toggle ✗ · TOC ✓ but a
**separate implementation** (slide titles, early-return, no headings) · airplane
mode ✓ · ribbon ✗ · **search ✗ — silently: `SearchTab` clears both indices and
returns** · camera: free within bounds · presenter/viewer role ✓ · `n`/`p` ✗.

### `png` {#kind-png}
Fetch: `HEAD`-probes `page-{n}.png` past the manifest count, then
`loadImageDocument`. Component: `createImageShapes`. Pages: images.
`page-info.json`: not the document's; `refreshSvgProjectParts` **will** run for
it (png ∉ `FORMATS_WITH_OWN_PAGE_INFO`) and attach parts if any exist.
Works: annotations ✓ · source anchoring ✗ · proof toggle ✗ · TOC — I could not
establish a png-specific TOC path; it takes the SVG/heading path with no
headings to find · **airplane mode ✗ and it throws**: `offlineDocumentUrls`
returns `[]` (not in the page-info set, no targets), and `cacheProjectsForOffline`
raises `"<name> has no offline-readable pages"` · ribbon ✗ · toolbar: **SVG_CONFIG**
· **not handled by `BookViewer` at all** — a png book member falls into the SVG
arm and calls `createSvgDocumentLayout`.

### `book` {#kind-book}
Not a viewable document. `config.format === 'book'` diverts to
`phase: 'book'`; members are resolved from the full manifest and each is loaded
by `BookViewer`'s own dispatch. `book` never reaches any of the §1c sites.

### Does `App.tsx`'s union match the server's? {#union-vs-server}

**No, in both directions, and the server has no enumeration to match.**

- **The server never validates `format`.** `POST /api/projects` destructures
  `format` from the body and passes it to `createProject` unchecked; the only
  format-specific validation is that `book` requires a non-empty `members`. Any
  string is accepted and stored.
- The server's *build-side* set is `builderForFormat` in
  `server/lib/build-decision.mjs`: `{markdown, html, slides, qmd}`, everything
  else → `runBuild` (LaTeX). That is four names plus a default — it never names
  `svg`, `png`, `book` or `diff`.
- **`png` is a client-only format** — see below.
- `svg` is named by the client union and by one telemetry default, and by
  nothing on the server.

So the client union is not a copy of a server enumeration; there is no server
enumeration. It is a sixth independent list.

#### `png` is a client-only format {#png-client-only}
`format: 'png'` is written in exactly one place in the repository:
`src/loaders/imageLoader.ts`, on its return value. Searched with a positive
control (the same query shape for `'slides'` returns ten sites across client and
server). **No server code ever sets or reads it.** The client's `DocConfig` union
advertises `png` as a value the API can return; the API cannot.

#### `diff` exists in exactly one place {#diff-nowhere}
`diff` appears as a format only as `DIFF_CONFIG` / `case 'diff'` in
`src/formatConfig.ts`, plus the prose of two comments (`formatConfig.ts`'s
header, and `shared/document-formats.mjs`'s header naming "svg, png, diff, …").
**No code assigns `format = 'diff'` anywhere, client or server.** The switch case
is unreachable and the two comments describe a format the app does not have —
AGENTS.md §"The mirror: a durable note can be the thing that expired", in both
of the files that are supposed to be this layer's design record.

---

## 3. Where a new kind would have to be touched {#new-kind}

Derived from §1 and §2. Not a proposal — a count of the sites that must be
edited before a new format renders at all, and then before it stops being
quietly broken.

### Before it renders at all — 9 sites, 6 files {#new-kind-minimum}

1. `src/App.tsx` — add the value to the `DocConfig.format` union.
2. `src/App.tsx` — add an arm to the main viewing dispatch.
3. `src/loaders/` — a new loader, which must decide **what `format` string to
   stamp** on its return value (§0). Stamping the new name makes every existing
   `HTML_PAGE_FORMATS`/`png`/`slides` test fall through to the LaTeX default;
   stamping an existing name makes the kind indistinguishable downstream.
4. `src/loaders/types.ts` — add the value to `SvgDocument['format']`.
5. `src/PanelContext.ts` — add the value to `ProjectContextValue['format']`
   (a third copy of the same union).
6. `src/editorSetup.ts` — add an arm to the 4-way initial shape creation, or it
   silently gets `createSvgShapes`.
7. `src/editorSetup.ts` — add an arm to `reloadPages`, or a rebuild takes the
   LaTeX SVG reload path against pages it does not have. **This is the exact
   failure `document-formats.mjs`'s own header records for `qmd`**: rebuilt
   correctly on the server, never changed on screen.
8. `src/svgPageFetchPolicy.ts` — add it to the no-SVG-fetch predicate, or the
   client fetches SVG pages that do not exist.
9. `server/lib/build-decision.mjs` — `builderForFormat`, or the format routes to
   the LaTeX builder. (Server-side, listed because without it nothing is built.)

### Before it stops being silently wrong — 14 more sites {#new-kind-correctness}

Each of these currently answers by *falling through to the LaTeX default*, which
means the failure is a wrong answer, not an error:

10. `shared/document-formats.mjs` — `FORMATS_WITH_OWN_PAGE_INFO`: decides whether
    `page-info.json` is its own pages or the project's parts. Wrong → the
    document renders **a second time, stacked on itself, swallowing clicks**
    (the deck failure the header records).
11. `shared/document-formats.mjs` — `HTML_PAGE_FORMATS`, which answers **three
    questions at once** (iframes / no-synctex / line-addressed source). A kind
    that answers them differently cannot be expressed by this set at all.
12. `src/hooks/useProofToggle.ts` — `hasProofInfo`.
13. `src/hooks/useYjsSignals.ts` — `hasSynctex`.
14. `src/hooks/useYjsSignals.ts` — `hasMismatchedRender`.
15. `src/annotationSourceAnchor.ts` — the synctex fallback gate.
16. `src/SvgDocument.tsx` — the source-map/hyperref load gate.
17. `src/formatConfig.ts` — the toolbar switch, or it gets the LaTeX toolbar.
18. `src/panels/TocTab.tsx` — TOC fetch, and TOC render if it needs its own.
19. `src/panels/SearchTab.tsx` — search source.
20. `src/DocumentPanel.tsx` — `isHtml`, and the button-TOC gate.
21. `src/editorSetup.ts` — the ribbon gate (a 4-clause `!==` chain, so a new
    kind gets the ribbon by default).
22. `src/airplaneMode.ts` — `offlineDocumentUrls`, or airplane mode **throws**
    for the kind rather than skipping it (the live `png` behaviour).
23. `src/hooks/useDocAutoOpen.ts` — five tests in one handler, all against
    `'markdown'`, none via `viewFormat`.
24. `src/BookViewer.tsx` — the **second** viewing dispatch, written differently
    from the first, plus its inlined `renderedFormat || format`.
25. `src/panels/ProjectTab.tsx` — two `=== 'svg'` tests on carrier 4.

**So: ~9 sites to render, ~25 to be correct, across ~15 files, and 3 copies of
the union type.** The distribution is the expensive part rather than the count:
the sites are spread over five carriers of a same-named field, only two of the
dispatches call `viewFormat`, and **the default arm everywhere is LaTeX** — so
an unhandled kind does not fail, it silently becomes a LaTeX document.

### What already exists at each of those sites {#new-kind-precedent}

`qmd` is the worked example and it needed all of it: a new `renderedFormat`
field, `viewFormat()`, membership in `HTML_PAGE_FORMATS`, a `BookContext`
field, a builder, and it **still** does not reach `useDocAutoOpen`.

---

## 4. Defects visible from this reading {#defects}

Reported as observations, not as work. Each is a place where the layer answers
confidently and wrongly.

| what | where | consequence |
|---|---|---|
| `useDocAutoOpen` does not call `viewFormat` and tests only `'markdown'` | `src/hooks/useDocAutoOpen.ts` | an `html`, `slides` or `qmd` document arriving over SSE is auto-opened as **`svg-page` shapes with `pageIndex` props** against a document with no SVG pages |
| `BookViewer` has no `png` arm | `src/BookViewer.tsx` | a png book member reaches `createSvgDocumentLayout`, which wants LaTeX targets it has never had — the same shape as the deck-member bug its own comment records as fixed |
| airplane mode throws rather than skips for png | `src/airplaneMode.ts` | `"<name> has no offline-readable pages"`; in a book, one png member fails the **whole** cache run, since `cacheProjectsForOffline` prepares all projects before caching any |
| `BookViewer` and `TocTab` inline `renderedFormat \|\| format` | both files | two hand-copies of `viewFormat`'s body; the drift `document-formats.mjs` was written to prevent, in the file that imports it |
| `case 'diff'` unreachable; two headers describe it as real | `src/formatConfig.ts`, `shared/document-formats.mjs` | the layer's design record names a format the app does not have |
| `case 'markdown'` / `case 'qmd'` unreachable | `src/formatConfig.ts` | dead by the restamp; harmless only because they map to the same config `html` does |
| `'markdown'` clause in the ribbon gate unreachable | `src/editorSetup.ts` | dead; covered by the `'html'` clause |
| three declared unions advertise 4 unreachable values | `App.tsx`, `loaders/types.ts`, `PanelContext.ts` | the type is not evidence about what the field holds |
| server accepts any `format` string | `server/routes/projects.mjs` | a typo'd format is stored, builds as LaTeX, and renders as LaTeX |

I did **not** verify any of these on a running server. They are read from `main`'s
source. §"An instrument that answers is not an instrument that measured" applies:
treat them as findings from reading, not as reproduced behaviour.

---

## 5. The thing I did not expect to find {#the-revert}

The newest commit touching `shared/document-formats.mjs`, `src/formatConfig.ts`
and `src/hooks/useDocAutoOpen.ts` is **`281e72172`, `Revert "Merge document
format architecture"`**, 2026-08-21 12:01 -0400, by `bhief-sol`. It reverts
`7d6f64f39`, **104 files, +645 / −1694**.

Among what it deleted: **`src/loaders/documentLoaderRegistry.ts`** and
`tests/documentLoaderRegistry.test.ts`, and a commit in that range titled
`carry document view capabilities through runtime` — which is where `viewFormat`,
`HTML_PAGE_FORMATS` and `DIFF_CONFIG` each show up in `git log -S`.

So the shape §3 measures is what the tree looks like **after** an attempt to
unify it was reverted. **The revert records no reason** — its message is git's
default text and nothing else. I could not establish why it was reverted; I did
not read the thread, because that is a question about the record rather than
about the code, and it is yours to decide whether to pursue.

I am reporting this because §3 asked how expensive a new kind is, and the answer
is not readable without knowing that the current shape is a restored one rather
than one nobody has looked at.

---

## What I did not establish {#gaps}

- **Whether any code path outside the `App.tsx` and `BookViewer.tsx` dispatches
  constructs an `SvgDocument`** with a `format` other than the four in §0. The
  restamp claim is proven for those two entry points.
- **A png document's TOC behaviour.** I found no png-specific path and inferred
  it takes the heading path with nothing to find; I did not confirm it.
- **Why `7d6f64f39` was reverted.** No reason is recorded in the commit.
- **Nothing was run.** No server started, no browser, no rendered document. Per
  the brief this was a read; where the report says a kind "silently doesn't"
  work, that is read from the branch structure, not observed on screen.
