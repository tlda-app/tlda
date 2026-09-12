# The server-side document format layer

`rc-read-build`, 2026-09-03. Read-only: nothing edited, committed, branched or designed.

**What this is relative to.** Every `git grep` below names `main` explicitly. `main` tip is
`4490e53ac103a1a8fb90b05665c1068c71a8cbd7` ("Reveal hover-only controls on devices that
cannot hover", 2026-09-03 16:18 EDT). The shared checkout is on `project-airplane-mode` at
`8f72658d9` — **same commit subject, different sha**, the cherry-pick artifact AGENTS.md
§"`main` is assembled by cherry-pick" describes. A bare grep here would have read the wrong
ref.

**Two instrument failures I hit and corrected, both of which produced a confident false
zero.** Recording them because either one, unnoticed, would have made this report wrong:

- `git grep -E "\.format\s*==="` returned **5 hits**. POSIX ERE has no `\s`. The same query
  as `git grep -P` returns **31**. The near-empty result read exactly like "nothing branches
  on format."
- Checking for real TeX, I built a stripped PATH with `paste -sd:`, which errored on this
  box's BSD `paste`. `$RP` was empty, `PATH= command -v pdflatex` found nothing, and I
  briefly had "no TeX on this machine." A `git` positive control on the same PATH exposed it.
  There *is* real TeX, at `/opt/homebrew/bin`.

---

## 1. The kinds

**Your starting observation is correct, and understated.** `DOCUMENT_FORMATS` in
`shared/document-roots.mjs` holds seven values and does not include `book`:

```
svg · png · html · diff · slides · markdown · qmd
```

`book` is branched on in six server files. But the disagreement is not one enumeration
against a scatter of `book` checks — **there are seven separate enumerations of "what a
format can be", and no two of them are the same set.**

| # | where | the set it enumerates | what it is |
|---|---|---|---|
| 1 | `shared/document-roots.mjs` `DOCUMENT_FORMATS` | svg, png, html, diff, slides, markdown, qmd | the filter `normalizeDocumentRoots` validates a stored root's format against |
| 2 | `shared/document-roots.mjs` `DOCUMENT_EXTENSION_FORMATS` | svg, markdown, qmd, html | extension → format, the only *derivation* of a format from a file |
| 3 | `shared/document-formats.mjs` `FORMATS_WITH_OWN_PAGE_INFO` | markdown, html, slides, qmd | who owns `output/page-info.json` |
| 4 | `shared/document-formats.mjs` `HTML_PAGE_FORMATS` | html, markdown, qmd | whose pages are scrolled iframes |
| 5 | `server/lib/build-decision.mjs` `shouldBuildOnPush` eager list | markdown, html, slides, qmd | which formats always build eagerly on push |
| 6 | `server/lib/build-decision.mjs` `builderForFormat` map | markdown, html, slides, qmd (default `runBuild`) | **dead — see below** |
| 7 | `bin/build-worker.mjs` inline builder object | markdown, html, slides, qmd (default `runBuild`) | **the real dispatch** |

**Sets 6 and 7 are two copies of the same decision, and only one of them runs.**
`builderForFormat` is exported from `build-decision.mjs` and has **zero callers** — verified
against `main` and against the whole tree, with `shouldBuildOnPush` as the positive control
(9 hits, so the query works). The dispatch that actually chooses a builder is an inline
object literal in the build worker:

```js
const builder = { markdown: buildMarkdown, html: buildHtml, slides: buildSlides, qmd: buildQmd }[project?.format]
```

That is `bin/build-worker.mjs`, the format-dispatch line in the `t: 'build'` handler.
**`bin/build-worker.mjs` is not in the file list you gave me** — the dispatch is not in
`build-dispatch.mjs`, which is about publication and queueing and never looks at a format
except to re-aggregate book TOCs.

**Where the sets disagree, and what follows from each disagreement:**

- **`book` is in none of the seven.** It is a project format only — an aggregate of member
  projects — and it can never be a *root's* format, because set 1 would reject it. It also
  falls through the builder object to `runBuild`, i.e. **a `book` project that ever reaches
  the build worker is handed to the LaTeX runner.** I did not establish whether a `book`
  can reach the worker; `routes/projects.mjs`'s `/push` handler guards on `format === 'book'`
  and takes a different path, so it may be unreachable. That is a gap, not a finding.
- **`png` and `diff` are in set 1 and in nothing else.** A root may legally be recorded as
  `png` or `diff`, and no builder, page-info rule, or view rule mentions either. Nothing
  derives them (set 2 cannot produce them), so they can only arrive from a caller supplying
  a root object literally.
- **Set 2 cannot produce `slides`.** `.html` maps to `html`. A deck becomes `slides` only
  because the CLI writes `format: 'slides'` explicitly at link time.
- **`slides` is in set 3 but deliberately not set 4.** The file's own comment records that
  the viewer once spelled set 3 out inline as "not html and not markdown", read a deck's
  page-info as a parts manifest, and rendered every slide twice.

**Two corrections to this section, from the same re-sweep as §3.**

**`HTML_PAGE_FORMATS` (set 4) has zero server-side consumers.** Nine call sites, all in
`src/` — `BookViewer`, `DocumentPanel`, `SvgDocument`, `annotationSourceAnchor`,
`editorSetup`, `useProofToggle`, `useYjsSignals`, `svgPageFetchPolicy`. It lives in `shared/`
and is imported only by the client. It is still one of the seven enumerations of "what a
format can be" and still disagrees with the others, but it is **not** part of the server-side
layer, and my first version implied it was.

**`shared/document-formats.mjs`'s own header comment is stale, on two counts.** It says the
server "named **all three** formats and honoured it in **five places**." The set holds
**four** today (`qmd` was added), and on `main` there is exactly **one** server call site —
the `include=page-info` clause now in §3. I did not establish when the other four went; the
comment describes a state that no longer exists. AGENTS.md §"The mirror: a durable note can be
the thing that expired" is the rule, and §"fix the note in the same pass" would apply to
whoever next edits that file — I am reading, not editing, so I am recording it here instead.

**`viewFormat(project)` is an eighth thing, and it is a different question from all seven.**
It answers *what are this project's pages*, as against *who rendered them*: for `qmd` it
returns `project.renderedFormat` (`'html'` or `'slides'`), for everything else it returns
`project.format` unchanged. So `qmd` is the one format where the build-side fact and the
view-side fact come apart.

---

## 2. Who decides

**There are four deciders, and they do not form a chain — they write at different times to
different fields.**

**(a) `formatForDocumentPath(file)` — `shared/document-roots.mjs`.** Extension → format, via
set 2. The only *derivation* from the file itself. Null for a non-document. Two callers:

- `server/routes/projects.mjs`, the chat click-adopt handler — the site that decides what
  format to record when a file is adopted as a document root. Its own comment records that it
  previously appended `format: 'markdown'` literally whatever was clicked, so a `.tex` adopted
  as a root was recorded as markdown and then had the markdown closure selected for it.
- `cli/tlda.mjs`, in the root-declaration path.

**(b) `documentRootsIn(files, read)` — `shared/document-roots.mjs`.** The graph walk. A
document is a node in the include graph with no incoming edge; its format comes from set 2.
This is the *computed* answer, and its header records Skip, 2026-08-26: *"document roots is
just a computed property of the git branch"*.

**(c) The CLI, at `project link` — `cli/tlda.mjs`.** This is where a *project's* format is
decided, and it is decided **once, at link time, by extension of the main file**, then stored:

```
ext === 'md'                  → format = 'markdown'
ext === 'html' | 'htm'        → format = 'html'
ext === 'qmd'                 → format = 'qmd'
```

with `format: 'slides'` and `format: 'book'` written explicitly at their own call sites, and
`svg` as the default in `createProject`.

**It can be overridden, and the override wins over everything.** `cli/tlda.mjs`:

```js
let format = getFlag('format') || existingRecord?.format || null
```

`--format` beats the existing record, which beats derivation. So a project's format is
**user-supplied first, sticky second, derived last** — and re-linking an existing project
preserves whatever it already had rather than re-deriving.

**(d) `build-qmd.mjs` writes `renderedFormat` — the only decider that runs at build time.**
The quarto builder reads the `format:` key out of the .qmd front matter and records what it
actually produced:

```js
renderedFormat: mainFiles.length === 1 && anyDeck && pageInfo.every(e => e.variant !== 'chapter') ? 'slides' : 'html'
```

This is the only format decision made by looking at a *render result* rather than a filename,
and it is the input to `viewFormat`.

**What I could not establish:** whether any server route rewrites `project.format` after
creation. `updateProject` takes an arbitrary patch, so it is *possible*; I found no call site
passing `format` to it, but "I found no caller" is weaker than "there is none" and I am not
claiming the stronger one.

---

## 3. Every branch site

Every server-side site on `main` that tests a project's or a root's format. **35 rows**,
nothing dropped. Cited by what the call site *is*.

> **Correction, added after the first send.** The version I chatted said 34 rows and was
> **incomplete by one**. My sweep pattern included `\.has\(\s*\w*[Ff]ormat`, which cannot match
> `.has(project.format)` — `\w*` stops at the dot. So every **set-membership** test of a format
> was invisible to it, and one real site was missed: the `include=page-info` clause in the
> project-detail route, now in the table below. I found it by re-running the sweep for the four
> named sets (`FORMATS_WITH_OWN_PAGE_INFO`, `HTML_PAGE_FORMATS`, `DOCUMENT_FORMATS`,
> `DOCUMENT_EXTENSION_FORMATS`) plus `switch` and `.includes()` forms, which the original pattern
> also could not see. `switch` and `.includes()` return **none** — that part was clean.
>
> This is the same class of error as the two false zeros already recorded at the top of this
> report: **a query that answers, about the wrong population.** Third one in this task.

### `shared/` — the shared rules

| path | the call site | what the branch does |
|---|---|---|
| `shared/document-roots.mjs` | `normalizeDocumentRoots`, root-format validation | keeps a stored root's format only if it is in set 1, else falls back to the project format |
| `shared/document-roots.mjs` | `normalizeDocumentRoots`, mainFile fallback | when no roots survive, synthesises one from mainFile, defaulting to `svg` if the project format is not in set 1 |
| `shared/document-roots.mjs` | `latexDocumentRootPaths` | selects only `svg` roots with a `.tex` extension as LaTeX render targets |
| `shared/document-formats.mjs` | `viewFormat` | returns `renderedFormat` for `qmd`, the project format otherwise |
| `shared/source-manifest.mjs` | `isSourceFilePath`, html/slides clause | everything beside the document is source — no reference graph exists for these |
| `shared/source-manifest.mjs` | `isSourceFilePath`, qmd clause | everything beside it is source *except* what the local quarto render just produced |
| `shared/source-manifest.mjs` | `isSourceFilePath`, markdown clause | membership by dependency extension only |
| `shared/source-manifest.mjs` | `isManagedSourcePath`, qmd clause | excludes quarto render output from a declared manifest |

### `server/lib/` — build

| path | the call site | what the branch does |
|---|---|---|
| `server/lib/build-decision.mjs` | `shouldBuildOnPush`, already-building guard | an `svg` project with 0 pages that is mid-build does not re-enqueue |
| `server/lib/build-decision.mjs` | `shouldBuildOnPush`, first-build clause | a brand-new `svg` project builds eagerly |
| `server/lib/build-decision.mjs` | `shouldBuildOnPush`, eager clause | markdown/html/slides/qmd always build eagerly on push |
| `server/lib/build-decision.mjs` | `shouldBuildOnPush`, relevance filter | only `svg` consults `relevant-files.json` to decide whether the change reaches the render |
| `server/lib/build-decision.mjs` | `builderForFormat` | **dead code** — maps format to a builder *name*; no caller |
| `bin/build-worker.mjs` | the build handler's format dispatch | **the live dispatch**; picks buildMarkdown/buildHtml/buildSlides/buildQmd, else `runBuild` |
| `server/lib/build-runner.mjs` | `_directReporter.regenerateBookTocs` | re-aggregates the TOC of every `book` project holding this project as a member |
| `server/lib/build-dispatch.mjs` | `regenerateBookTocs` sink | the same walk, on the server side of the IPC boundary |
| `server/lib/build-markdown.mjs` | post-build book re-aggregation | same walk again, inline at the end of the markdown build |
| `server/lib/build-qmd.mjs` | front-matter format read | reads the author's `format:` key out of the .qmd YAML |
| `server/lib/build-qmd.mjs` | single-root manifest page | stamps `source: { type: 'project-source', format: 'qmd' }` |
| `server/lib/build-qmd.mjs` | multi-root page entries | same stamp per root, plus `format: 'qmd'` on the page |
| `server/lib/build-qmd.mjs` | single-root `renderedFormat` | records `'html'` |
| `server/lib/build-qmd.mjs` | multi-root `renderedFormat` | `'slides'` if exactly one root rendered a deck with no chapter pages, else `'html'` |
| `server/lib/tlda-manifest.mjs` | manifest page validation | **throws** unless each page declares `source.type === 'project-source'` and `source.format === 'qmd'` |

### `server/lib/` — model and storage

| path | the call site | what the branch does |
|---|---|---|
| `server/lib/project-store.mjs` | `createProject` | a `book` gets `members` and gets **no** `mainFile` and **no** `documentRoots` |
| `server/lib/project-store.mjs` | `addBookMember` | creates the containing project as `format: 'book'` when it does not exist |
| `server/lib/document-columns.mjs` | `listDocumentColumns` | only a `markdown` project has document columns; every other format returns `[]` |
| `server/lib/document-columns.mjs` | `listMarkdownProjectDocuments` | same gate for the Projects document picker |
| `server/lib/shadow-repo.mjs` | version-trigger projection | only a `markdown` project compares previous/current markdown projections to decide a version |
| `server/lib/project-artifact-materializer.mjs` | markdown root selection | materializes only `markdown` roots ending `.md`/`.markdown` |

### `server/routes/projects.mjs`

| path | the call site | what the branch does |
|---|---|---|
| `server/routes/projects.mjs` | project-create validation | **400** if `format === 'book'` with an empty or absent members array |
| `server/routes/projects.mjs` | chat click-adopt handler | derives the root's format from its path; refuses `not-a-document` if null |
| `server/routes/projects.mjs` | members-replace handler | **400** on a non-`book` project — its comment records that the `/push` branch carrying members falls through to a normal push, so a members array to a non-book project silently became an empty file push |
| `server/routes/projects.mjs` | documents listing, markdown clause | a `markdown` root becomes a markdown project-root column |
| `server/routes/projects.mjs` | documents listing, output-file naming | an `svg` root maps to `<base>-page-1.svg`; every other format maps to `.html` |
| `server/routes/projects.mjs` | macros handler | a non-`svg` project with no declared targets returns `{}` — no macros |
| `server/routes/projects.mjs` | project-detail route, `include=page-info` clause | **the missed row** — inlines `page-info.json` into the project response only when the format is in `FORMATS_WITH_OWN_PAGE_INFO`; the sole server-side consumer of that set |

### `server/unified-server.mjs`

| path | the call site | what the branch does |
|---|---|---|
| `server/unified-server.mjs` | non-`.html` docs request, access gate | only an `html` project consults classroom document access before serving |
| `server/unified-server.mjs` | docs page-info handler | only an `html` project reads a chapter list out of `page-info.json` and takes the head from the first chapter |
| `server/unified-server.mjs` | document-column resolution | a `markdown` project lists its own document columns; every other format lists **parts** plus its `markdown`-format roots |
| `server/unified-server.mjs` | column fallback | only a `markdown` project falls through to resolve an output file as a document column |
| `server/unified-server.mjs` | chapter prev/next (column path) | walks every `book` project to find the one holding this member, for prev/next |
| `server/unified-server.mjs` | project-path serve handler | **the only `viewFormat` call site on the server** — `slides` gets the reveal bridge injected, `markdown` takes the markdown path |
| `server/unified-server.mjs` | chapter prev/next (viewFormat path) | the same book walk, on the `viewFormat` branch |
| `server/unified-server.mjs` | `getLatexProjectDirs` | only `svg` projects with a `sourceDir` are treated as LaTeX trees |

**Outside `server/`, for completeness** (you scoped the question to the server side, so these
are noted, not counted): `bin/stale-panels.mjs` filters `markdown` roots; `cli/lib/source-files.mjs`
gates on `format !== 'markdown'`; `cli/tlda.mjs` has the four link-time format branches
already covered in §2.

---

## 4. What happens when the TeX toolchain is absent

**I could not settle this by reading, so I ran it.** Disposable project in the session
scratchpad, its own projects dir, nothing near `pic`, `pic-dev` or `testing`, no server
started, no real environment touched.

**The rig can go green — that is the first thing established, not an aside.** With real TeX
on PATH the same harness produced a genuine successful build: `main.dvi`, 1 page, 348 bytes,
`Build complete in 55.5s`, and an `output/` holding eleven artifacts. So a subsequent failure
is a fact about the missing toolchain rather than about my harness. AGENTS.md §"A negative
result is only evidence once the instrument can produce a positive."

**Then, with `pdflatex`, `latexmk`, `dvisvgm`, `biber` and `bibtex` all absent from PATH
(`node` and `git` confirmed still resolving on the same PATH):**

```
[build] Building preamble format...
[build] Format creation failed with no LaTeX error in its output: Command failed: pdflatex -ini ...
[build] No format available — using pretex wrapper
[build] Compiling...
[build] pdflatex exited with warnings (continuing): Command failed: pdflatex --output-format=dvi ...
[build] pdflatex done in 0.2s
[build] Build status signal sent (0 errors, 0 warnings)
[build] BUILD FAILED: DVI file not created
```

### Where it fails

**Not where the toolchain is missing — two stages later.** `build-runner.mjs` runs pdflatex
inside a `try` whose `catch` logs `pdflatex exited with warnings (continuing)` and **carries
on**. `sh: pdflatex: command not found` is a non-zero exit like any other, so an absent
binary is indistinguishable from a LaTeX warning at that site. The build then fails at the
DVI existence check — the guard immediately after the bibliography pass — with:

> **`DVI file not created`**

**That message names the symptom and never the cause.** The shell's actual words are
discarded: the log line is `e.message.split('\n')[0]`, which is the `Command failed:` wrapper,
not the `command not found` underneath it. An operator reading `DVI file not created` on a box
with no TeX is being told the document did not render, in language that reads like a LaTeX
problem.

The nearest thing to a real signal is the earlier line — `Format creation failed with **no
LaTeX error in its output**` — which is exactly the shape a missing binary produces, since
`latexErrorSummary` returns null when there is no TeX output to summarise. Nothing says so.

### What reaches the project's build status

**`buildStatus: 'failed'` does reach `project.json`.** I want to be precise here because
reading the build worker alone would suggest otherwise: the worker's `catch` records a
`build_failed` *lifecycle phase* and does not patch `buildStatus`. The patch comes from
`runBuild`'s own outer catch, which calls `updateProject(name, { buildStatus: 'failed' })`.
Observed sequence, in order:

```
updateProject  {"buildStatus":"building","lastBuild":"..."}
broadcastSignal  signal:build-progress
broadcastSignal  signal:build-status
updateProject  {"buildStatus":"failed"}
writeSentinel
broadcastSignal  signal:build-status
broadcastSignal  signal:build-progress
emitGlobalEvent  build-card
```

So the failure is honest at the status level. What it is not is *diagnostic*: `build.log`
exists and holds the trail above, and **`latex.log` is absent entirely** — there is no TeX to
write one. A project whose `latex.log` is missing while `build.log` says `DVI file not created`
is the signature of this case, and nothing states it.

### What the viewer ends up showing

**The last good render, unchanged** — for a project that had one. The failed build dies inside
its build instance, `publishBuildInstance` is never reached, and AGENTS.md's rule that a failed
build must never replace a working render holds here exactly as designed. For a **new** project
there is nothing to keep: `output/` was empty and `pages` stayed 0, so the viewer has no pages
at all, alongside a `failed` build card.

### Does anything on the serving path detect the absence

**No. `checkBin('latexmk')` in `cli/tlda.mjs`'s doctor is the only TeX presence check in the
repository**, and `doctor` is not on the serving path — it runs when someone asks it to. My
grep for `checkBin(` / `command -v` / `which latexmk` across `server`, `cli`, `bin`, `daemon`
and `shared` on `main` returns four call sites and its own positive control found the known
one; nothing in `server/` checks for TeX at all.

**And the contrast inside this same layer is the sharpest thing in this report.** The quarto
builder does exactly what the LaTeX path does not — `build-qmd.mjs` resolves its toolchain up
front and throws a message naming the fix:

> `quarto is not on PATH — a .qmd project cannot be built without it. Install it with 'brew install --cask quarto'.`

and the same again for `Rscript`. Its comment even argues the design: *"PATH is the only
source… a machine that renders .qmd has quarto on PATH."* **So the server already knows how to
answer this question; it answers it for `qmd` and not for `svg`.**

### One more thing, and it may matter more than the absent-TeX case

**On this Mini, TeX is present but an agent cannot invoke it.** `~/.claude/bin/latexmk` and
`~/.claude/bin/pdflatex` are symlinks to a fence wrapper that, when `FLEET_ID` is set in the
environment, prints *"this looks like busy work"* to stderr and **exits 64 without
compiling** — unless `--yes-really-compile` is passed. Real TeX is at `/opt/homebrew/bin`,
behind that shim on an agent's PATH.

A tlda server **started by an agent inherits `FLEET_ID`**, and `build-runner.mjs` invokes
`pdflatex` by bare name through the shell, so it resolves to the shim. Every LaTeX build in
such a server would fail with `DVI file not created` and an absent `latex.log` — the exact
signature above — while `pdflatex` is installed and works fine from Skip's own shell.

**I have not established that this has happened**, and I did not start a server to try, since
that is a step past what you asked and the disposable-project rule made me want your call
before doing it. I am reporting the mechanism and the two facts it rests on (the shim's exit-64
behaviour on `FLEET_ID`, and the bare-name invocation), both of which I read directly. Whether
any real box is in this state is a separate question and not one I answered.

---

## What I could not establish, distinctly from "there is nothing there"

- Whether a `book` project can actually reach the build worker's format dispatch, where it
  would fall through to `runBuild`. The `/push` route guards on `format === 'book'` before
  that point; I did not trace every admission path.
- Whether any server route rewrites `project.format` after creation. I found no call site
  passing `format` to `updateProject`, but `updateProject` takes an arbitrary patch and I did
  not enumerate its callers exhaustively.
- Whether the fence-shim failure mode above has occurred on any live box. Mechanism read;
  incidence not measured.
