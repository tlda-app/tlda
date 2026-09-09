# What PDF means in this codebase today

`rc-read-pdf`, for `pm-rc-docformat`. All claims against **`main` = `4490e53ac`**.
The shared checkout sits on `project-airplane-mode`, so every grep below names `main`
explicitly. Runs were on the **Mini**, load 44–57 on 10 cores throughout, on a
disposable fixture in my scratchpad. Nothing touched `pic`, `pic-dev`, or `testing`.

---

## Summary

**Reading A is much cheaper than it looks, and Reading B is already possible today.**

- The annotation system's canonical coordinate space is **literally PDF page space**
  (`canvasToPdf`, `pdfToCanvas`, `pdfSpan`, `pdf_width`/`pdf_height`). A PDF is the
  most natural citizen of that space, not a foreign one.
- A **paged, non-text, build-free document kind already exists**: `png`. Reading A is
  that kind plus a rasterizer, and every input it needs can be produced from a PDF
  with tools already installed here.
- **The source-sync path is already binary-safe and already has a Skip ruling about
  PDFs.** It is not an obstacle.
- **The real cost is in the viewer's format sets**, which are not an enumeration but a
  binary partition with "LaTeX SVG document" as the *unmarked default*. A new `pdf`
  format added naively inherits synctex, proof data, and SVG page fetching.
- **Reading B works now**: quarto→typst and headless-Chrome both produced real PDFs
  with real text layers, no LaTeX involved.

---

## 1. What PDF handling exists today

**Correcting the starting observation.** The brief's premise was two hits, both a 📕
attachment icon. That is not what is there.

```
git grep -il "pdf"  main -- server/lib server/routes shared src cli daemon bin  → 51 files
git grep -il "qmd"  main -- (same paths)                                        → 51 files   ← positive control
git grep -in "pdf"  main -- (same paths)                                        → 419 lines
```

The positive control returns a comparable, non-degenerate set, so the 51 is a real
count and not an artifact of the query. `package.json` on `main` has **no** pdf,
poppler, mupdf, or typst dependency (positive control: the same grep shape finds
`playwright`, `tldraw`, `yjs` entries).

The 419 lines fall into **four** groups, not one.

### (a) LaTeX-build-internal — confirmed red herring

`generateStubPdfs` and `pdfBoundingBox` in the build runner write and read minimal
PDFs so LaTeX draft mode can recover figure `MediaBox` dimensions, with the `.bb`
sidecar writer beside them. Your first-pass reading of this is right and I did not
re-litigate it.

### (b) The synctex / annotation coordinate system — **not** a red herring

This is the group the two-hit premise missed, and it is the largest: `pdf_height` (61),
`pdflatex` (51), `pdfy`/`pdfx`/`pdfymin`/`pdfymax`, `pdfToCanvas` (12), `canvasToPdf` (8),
`sourceTextSpanToPdfSpans` (7), `pdfSpan`, `pdfPosition`, `pdfToSource`, `pdfSpansToCanvasMark`.

Call sites: `src/synctexAnchor.ts`, `src/synctexLookup.ts`, `src/sourceMap.ts`,
`server/lib/synctex-query.mjs`, `server/lib/word-synctex.mjs`.

**What this means.** Because synctex is a PDF↔TeX map, tlda's annotation geometry
adopted PDF page space as its canonical coordinate system — even though what is
actually rendered on the canvas is SVG. `canvasToPdf(x, y, document.pages)` is named
for PDF but is **pure page geometry**: it converts a canvas point to a
`(page, x, y)` triple against the page boxes. It is already format-agnostic and it
already runs for `png` documents.

So the codebase does not merely lack PDF support — **its anchoring layer already
speaks PDF coordinates natively.**

### (c) Source membership for `.pdf` — a Skip ruling, already implemented

`shared/source-manifest.mjs`, in `isSourceFilePath`, carries this:

> Skip, 2026-08-26: *"a pdf with no corresponding tex or svg is a source"*

The mechanism is an ordering, and the comment is explicit that it is deliberate:
**membership is decided before the junk test.** `.pdf` is in `BUILD_JUNK_SUFFIXES`
because a `.pdf` is usually the compiled paper, but `ctx.referencedRoots.has(rel)`
returns `true` *above* that test. So a `.pdf` reached by `\includegraphics` — or
declared as a document root — is source and travels; a `.pdf` reached by nothing is
junk and does not.

The same reasoning is repeated in `cli/lib/source-files.mjs` in the comment above
the closure walk (`withReferencedRoots`).

### (d) The chat attachment icon

`src/fleet/chat-render.mjs` — the 📕 the premise found. Cosmetic, no document meaning.

### Does anything ever *write* a `.pdf`?

Only (a) — the stub PDFs for `MediaBox` recovery — and LaTeX's own output during
`runBuild`. Nothing writes a PDF as a deliverable. **No print-to-PDF call exists
anywhere in the tree**: `git grep -n "\.pdf(\|printToPDF" main -- src server cli bin daemon`
returns nothing, and the positive control `\.screenshot(` returns hits in five test
files, so the zero is real.

---

## 2. Reading A — view a PDF that already exists

### The precedent nobody named: `png`

`src/loaders/imageLoader.ts` exports `loadImageDocument(name, imageUrls, basePath)`,
which returns `{ name, pages, basePath, format: 'png' }`. It:

- fetches a list of page images, measures each, and lays them out vertically with `PAGE_GAP`;
- centres them on the widest page;
- **and optionally fetches `text-data.json` beside them**, typed `PageTextData[]`, one
  entry per page, attached as `page.textData`.

That is a paged, non-text, build-free document kind that already exists, already
renders, and already carries a selectable text layer over raster pages. **Reading A is
this kind with a PDF rasterizer in front of it.**

### What a PDF would have to produce, and whether it can

`PageTextData` (`src/TextSelectionLayer.tsx`) is:

```ts
interface TextLine   { text: string; x: number; y: number; fontSize: number; fontFamily: string }
interface PageTextData { lines: TextLine[]; viewBox: { minX; minY; width; height } }
```

I produced every one of these from a PDF on this Mini, on a disposable fixture:

| need | tool | result |
|---|---|---|
| page count + page box | `pdfinfo` | `Pages: 1`, `Page size: 595.276 x 841.89 pts` → the `viewBox` and `page-info.json` dims |
| page raster images | `pdftoppm -png -r 144` | `page-1.png`, exit 0 — what `loadImageDocument` fetches |
| page raster images (server route) | `gs -sDEVICE=png16m` | `gs-1.png`, exit 0 |
| text layer | `pdftotext -bbox` | `<page width="595.2756" height="841.8898">` + `<word xMin=… yMin=… xMax=… yMax=…>Hello</word>` |

**Caveat, stated rather than glossed:** `pdftotext -bbox` gives per-word boxes but not
`fontSize` or `fontFamily`, which `TextLine` requires. Those would have to be derived
(box height) or come from a real PDF library. I did **not** establish that the derived
values are good enough for the text layer — that is a genuine open item, not a zero.

### Where it would actually bite

**Not the closure walker, and not source sync.** Both are already guarded:

- `documentRootsIn` (`shared/document-roots.mjs`) filters candidates through
  `DOCUMENT_EXTENSION_FORMATS`, and `edgesFrom` returns `[]` for anything not in
  `SCANNABLE`. A `.pdf` contributes no edges and never crashes a text scan.
- `readForUpload` (`cli/lib/source-files.mjs`) base64-encodes anything failing
  `isTextSourcePath`, so **binary files already travel**. Measured:
  `isTextSourcePath('paper.pdf')` → `false`, and it takes the base64 branch.
- The closure walk in `withReferencedRoots` picks `closureFor` by extension and
  `continue`s when there is none, so a `.pdf` root is already a no-op there.

**Measured, by running the real functions on `main`:**

```
formatForDocumentPath('paper.pdf')                      → null
documentRootsIn(['paper.pdf','main.tex','notes.md'])    → [main.tex/svg, notes.md/markdown]   ← the .pdf is dropped
isSourceFilePath('figures/diagram.pdf') unreferenced    → false
isSourceFilePath('figures/diagram.pdf') referenced      → true
isSourceFilePath('paper.pdf') as a DECLARED ROOT        → true      ← it already travels
isManagedSourcePath('paper.pdf')                        → true
```

So the sync obstacle in your first pass is **half true and the important half is the
other way**: `.pdf` is excluded from `SOURCE_EXTENSIONS`, but a `.pdf` that is a
declared root or a referenced file is admitted *above* that test and reaches the
server today. The blocker is not sync. **The blocker is that `.pdf` is not in
`DOCUMENT_EXTENSION_FORMATS`, so it can never be computed as a root** — one Map in
`shared/document-roots.mjs`.

**The text assumption lives entirely in the viewer**, and it is a default rather than
a check. See §4.

### Sites Reading A touches

| site | what changes |
|---|---|
| `DOCUMENT_EXTENSION_FORMATS` (`shared/document-roots.mjs`) | add `['.pdf', 'pdf']` — the one line that makes a `.pdf` a computable root |
| `DOCUMENT_FORMATS` (same file) | add `'pdf'` so `normalizeDocumentRoots` stops coercing it |
| builder dispatch (`bin/build-worker.mjs`, `builderForFormat` in `server/lib/build-decision.mjs`) | **must** gain a `pdf` entry — see §3's finding on the default |
| a rasterizer step | PDF → page PNGs + `page-info.json` + `text-data.json`; `gs` is already in `Dockerfile.live` |
| static serving | none needed — page images serve as the `png` path already does |
| viewer | `loadImageDocument` already does the layout; the selection is in `src/App.tsx` (`shownAs === 'png'`) |
| the five format-set sites | **the real work** — see §4 |

---

## 3. Reading B — produce a PDF without TeX

### What is actually installed here, established by running it

| tool | status |
|---|---|
| `pdflatex`/`latexmk`/`xelatex` on PATH | the **fence shim** at `~/.claude/bin/`, which refuses for `FLEET_ID` processes |
| real TeX | `/opt/homebrew/bin/pdflatex` → `Cellar/texlive/20260301`. **This Mini has TeX.** |
| `quarto` | `/Applications/quarto/bin/quarto` |
| **bundled `typst`** | `/Applications/quarto/bin/tools/aarch64/typst` |
| **bundled `pandoc`** | `/Applications/quarto/bin/tools/aarch64/pandoc` |
| `gs`, `pdftoppm`, `pdfinfo`, `pdftotext` | installed (`/opt/homebrew/bin`) |
| `pandoc`, `tectonic`, `weasyprint`, `wkhtmltopdf`, `qpdf`, `mutool`, standalone `typst`, `chromium` | **absent from PATH** |

Your note that `--version` is a false positive is right, so every row below is an
**artifact**, produced under a writable sandbox `HOME` in my scratchpad.

### The three candidates, by artifact

**1. typst directly — works.**
```
typst compile t.typ t.pdf     REAL exit=0
t.pdf: PDF document, version 1.7, 1 pages   (13,412 bytes, Creator: Typst 0.14.2)
```
`pdftotext` recovers the content *including math*: `Some prose, and inline math 𝑥2 + 𝑦2 = 𝑧2`
and `∫ 𝑓(𝑥) 𝑑𝑥 = 1`. **It carries a real text layer.**

**2. `quarto render --to typst` from a `.qmd` — works, no LaTeX.**
```
quarto render doc.qmd --to typst    REAL exit=0
[typst]: Compiling doc.typ to doc.pdf...DONE
doc.pdf: PDF document, version 1.7, 1 pages   (17,983 bytes)
```

**3. Headless Chrome print-to-PDF via the playwright browser — works.**
```
page.pdf({format:'Letter'})    REAL exit=0
chrome.pdf: PDF document, version 1.4, 1 pages   (18,068 bytes)
pdftotext → "Disposable fixture / Prose and a table. / ab"
```
**Instrument note:** my first attempt failed with `Executable doesn't exist at
…chromium_headless_shell-1232…`. That is a playwright version mismatch, **not** a
capability finding — `chromium_headless_shell-1234` is installed and works when named
explicitly. Reporting the first run as "Chrome can't do it" would have been a false
absence.

**4. `quarto render --to pdf` — a LaTeX route by construction; failed here.**

Quarto's own resolved metadata for this route reads `to: latex`, `pdf-engine: lualatex`.
That is solid evidence about **the route** and is independent of this box. The run
failed, but for a *compound* reason I want to be exact about, because it does not
cleanly establish what it looks like it does:

- `lualatex` on PATH is the fence shim, which refused: *"this looks like busy work …
  rerun it with `--yes-really-compile`"*;
- quarto then went on to `updating tlmgr` / `updating existing packages` and ended
  `ERROR: compilation failed- missing packages (automatic installation failed)`.

**Could not establish:** whether `--to pdf` would complete with the real TeX binaries
first on PATH. I did not run that, because doing so means evading the fence shim,
which exists precisely to stop agents hand-compiling. It also would not change the
answer to the question asked — the route is LaTeX either way, and the target is a box
with no TeX.

### What this means for a TeX-less box

`Dockerfile.live` carries **both** the ~2–3 GB TeXLive layer **and** Quarto 1.9.38
(`ARG QUARTO_VERSION=1.9.38`), plus `ghostscript`. `Dockerfile.agent` states in its
header *"This image deliberately has NO TeXLive and does NOT serve the viewer"* and
installs only `tmux git ca-certificates curl build-essential python3 python3-venv procps`.

So: **the typst route needs no new dependency on the render box** — quarto 1.9 is
already there and bundles typst. A viewer box built *without* the TeXLive layer would
still produce PDFs via typst.

**Not established:** neither image installs poppler (`pdftoppm`/`pdftotext`).
`Dockerfile.live` has `ghostscript`, which covers rasterization; PDF **text
extraction** has no tool in either image today.

---

## 4. The document-format layer — does PDF land as one more member?

**No. The sets are not an enumeration of formats. They are a binary partition with
"LaTeX SVG document" as the unmarked default.**

`shared/document-formats.mjs` defines two sets, and its own header for `HTML_PAGE_FORMATS`
says what the second one really carries:

> The same set answers "does this document have synctex/proof data" (it does not —
> those come from a LaTeX build) and **"is the source a line-addressed text file the
> anchor code can resolve against."**

So one set answers three different questions at once. Now look at how it is consumed —
every site is a **negative** test with a hardcoded exception list:

| call site | expression |
|---|---|
| `src/svgPageFetchPolicy.ts` — the page-fetch policy | `if (HTML_PAGE_FORMATS.has(f) \|\| ['png','slides'].includes(f))` |
| `src/hooks/useYjsSignals.ts` — `hasSynctex` | `!HTML_PAGE_FORMATS.has(f) && !['png','slides'].includes(f)` |
| `src/hooks/useProofToggle.ts` — `hasProofInfo` | `!!basePath && !HTML_PAGE_FORMATS.has(f) && !['png','slides'].includes(f)` |
| `src/SvgDocument.tsx` — the text-extraction branch | `if (!HTML_PAGE_FORMATS.has(f) && !['png','slides'].includes(f))` |
| `src/annotationSourceAnchor.ts` — `annotationSourceAnchorAtCanvasPoint` | `if (HTML_PAGE_FORMATS.has(f)) return null` — then falls through to `canvasToPdf` + `getSourceAnchor` |

**The consequence, stated plainly: a new format string `'pdf'` added to the extension
map and nothing else falls into the *else* branch at every one of these sites and is
treated as a LaTeX SVG document** — asked for synctex it does not have, proof data it
does not have, and SVG pages it does not have.

Two further facts make this the expensive part rather than a footnote:

- **`['png','slides']` is an inline literal repeated at four sites, not a shared set.**
  That is precisely the drift `document-formats.mjs`'s header was written to end — it
  records the viewer having spelled the same rule out inline as "not html and not
  markdown" and thereby rendering every slide twice. The same shape is present again,
  in four copies.
- **`png` is in `DOCUMENT_FORMATS` but not in `DOCUMENT_EXTENSION_FORMATS`.** So the
  existing non-text document kind cannot be computed as a root either. Whatever PDF
  needs here, `png` needs too.

### The unknown-format default: yes, "I don't know what this is" is "run LaTeX on it"

You asked me to settle this with a run. **Confirmed, at two independent sites:**

```
builderForFormat("markdown") → "buildMarkdown"      builderForFormat("svg")       → "runBuild"
builderForFormat("qmd")      → "buildQmd"           builderForFormat("pdf")       → "runBuild"
builderForFormat("html")     → "buildHtml"          builderForFormat("banana")    → "runBuild"
builderForFormat("slides")   → "buildSlides"        builderForFormat(undefined)   → "runBuild"
```

`server/lib/build-decision.mjs`'s `builderForFormat` ends `return map[format] || 'runBuild'`,
and `bin/build-worker.mjs` independently does `{markdown,html,slides,qmd}[project?.format]`
and calls `runBuild(...)` in its `else`. `runBuild` is the LaTeX path. So an
unrecognised format is dispatched to LaTeX — which is why the `format: 'pdf'` fixture
in `bin/a-scratch-section-still-builds-test.mjs` builds at all: it is a LaTeX project
wearing a format string nothing enumerates.

**A correction to your first pass, and it matters for this question.**
`normalizeDocumentRoots` does **not** uniformly coerce an unrecognised format to `svg`.
It has three branches and only two of them coerce:

```
normalizeDocumentRoots(['main.tex'], {mainFile:'main.tex', format:'pdf'})  → [{path:'main.tex', format:'pdf'}]   ← NOT coerced
normalizeDocumentRoots([],           {mainFile:'main.tex', format:'pdf'})  → [{path:'main.tex', format:'svg'}]   ← coerced
normalizeDocumentRoots([{path:'a.pdf',format:'pdf'}], {format:'svg'})      → [{path:'a.pdf',   format:'svg'}]    ← coerced
```

The declared-roots branch validates the *per-root* format against `DOCUMENT_FORMATS`
but then falls back to the **unvalidated top-level `format` argument**. So an invalid
format leaks into a stored root record.

**And the leak is then silently dropped downstream.** `latexDocumentRootPaths` filters
`root.format === 'svg'`, so the leaked root contributes nothing:

```
latexDocumentRootPaths(['a.tex','b.tex'], {format:'pdf'})  → []
latexDocumentRootPaths(['a.tex','b.tex'], {format:'svg'})  → ['a.tex','b.tex']
```

With a `mainFile` set this is masked, because `mainFile` is unioned in unconditionally.
Without one, a project with an unrecognised format has **zero** LaTeX roots while still
being dispatched to `runBuild`. I did not find a live caller that reaches that state,
so I am reporting it as a property of these functions, not as an active defect.

---

## What I could not establish

Distinct from "there is nothing there":

1. Whether `quarto render --to pdf` completes with the real TeX binaries first on
   PATH. Not run — it requires evading the fence shim, and it does not change the
   answer to the question asked.
2. Whether `fontSize`/`fontFamily` derived from `pdftotext -bbox` boxes are good
   enough for `PageTextData`, or whether a real PDF library is required.
3. Whether any live caller reaches the zero-LaTeX-roots state in §4.
4. What a PDF text layer would cost on the **server** images — neither installs
   poppler, and I did not test PDF.js or any node PDF library (there is no pdf
   dependency to test).

## Which reading the code makes cheap — as a measurement

**Reading A is cheap in the places you would expect it to be expensive, and expensive
in one place nobody has named.** Sync, the closure walker, and static serving cost
nothing — they are already binary-safe or already guarded. The annotation geometry
costs nothing — it is already PDF-shaped. The rasterization inputs are all producible
with installed tools. **The cost is concentrated in the five format-set call sites in
§4**, where the default branch means LaTeX, and in the fact that fixing them properly
means turning a binary partition into a positive capability question — which is a
change to a shared set that eight files import.

**Reading B is cheaper still and is not blocked at all.** Three working routes exist
today, two of them requiring nothing that is not already installed on the render box.
The question it raises is not feasibility but which output is wanted, since typst,
LaTeX, and Chrome print produce visibly different documents from the same source.
