# Document-format architecture

A tlda document has three independent axes:

| axis | examples | owns |
| --- | --- | --- |
| source format | `tex`, `qmd`, `md`, `pdf`, `html` | authored root and source discovery |
| renderer | `latex`, `quarto`, `markdown`, `identity` | build routing |
| document format | `paged`, `html`, `slides` | viewer and interaction model |

These are stored as `sourceFormat`, `renderer`, and `documentFormat`, and they
are authoritative for source and build identity.

**A record carrying only the older `format` field is derived from, not
rejected.** `documentAxes()` maps the legacy value to the three axes; a project
written as `format: 'svg'` reads back as `tex`/`latex`/`paged`. An earlier
version of this layer did reject such records at startup, and that sentence
stood here describing it — but the rejection meant the server would not start
against any store that predated the change, which is every existing store. The
derivation replaced it. There is still no migration step, because none is
needed: nothing has to be rewritten for a legacy record to resolve.

Every builder returns a document manifest and `buildDocument()` writes it to
`output/document-manifest.json`. It identifies the source root and renderer, the
document format, ordered display pages with dimensions, assets, optional
searchable-text geometry, and the available source-mapping mode. Its `view`
capabilities are the sole runtime viewer behavior contract.

Renderer adapters are registered in `server/lib/build-adapter-registry.mjs`.
Each returns one `BuildResult`, and `buildDocument()` is the completion
boundary. For an adapter that does not set `ownsCompletion` it owns the build
log — those run inside `withBuildLog`, so a build that throws still leaves its
reason on disk — and it records the version disposition, publishes the manifest
and project state, signals reload, and reports success. The LaTeX adapters do
set `ownsCompletion`, and their logging, project-state and version-disposition
updates, reload signaling and completion reporting all stay inside `runBuild`;
for them the boundary writes the manifest and nothing else. The worker and build
decision code ask the registry and contain no format switch.

**Two adapters complete themselves, and the boundary defers to them.** The
`latex` and `latex-slides` adapters are `runBuild`, which has always written its
own project update, reload signal, `build.log`, version and build-complete
webhook. Running the common tail over that would version twice, complete twice
and reload the viewer twice, so those adapters declare `ownsCompletion: true`
and the boundary does the one thing `runBuild` does not — put the manifest on
disk. Every other adapter gets the full tail.

The manifest's `view.kind` and capabilities are the client contract. Direct
open and foreign auto-open both call the registry in
`src/loaders/documentLoaderRegistry.ts`; neither reconstructs a loader choice
from project source or renderer fields. Thus a new artifact kind adds one
builder registration and, only if the artifact kind itself is new, one loader
registration.

The combinations currently implemented are:

| source | renderer | document | display artifact | source mapping |
| --- | --- | --- | --- | --- |
| TeX | LaTeX | paged | lazy SVG pages | SyncTeX |
| TeX | LaTeX | slides | lazy SVG pages | SyncTeX |
| Markdown | Markdown | HTML | rendered HTML | page/source |
| QMD | Quarto | HTML | rendered HTML | page/source |
| QMD | Quarto | slides | RevealJS slide pages | none |
| QMD | Quarto | paged | preserved PDF plus extracted SVG pages | none |
| HTML | identity | HTML or slides | preserved HTML and assets | optional page/source |
| PDF | identity | paged | preserved PDF plus extracted SVG pages | none |

A native PDF is an ordinary versioned document root. `tlda project link
book.pdf` submits the PDF through the daemon's canonical Git source path. The
builder preserves it, extracts ordered SVG pages and per-page text geometry,
and writes the common manifest. Search uses the extracted text. Annotations,
links, comparison, and history use page and document coordinates; source-line
mapping is explicitly unavailable. Historical pages are extracted from the PDF
checked out at the requested Git revision, not from a separate snapshot store.

PDF source discovery is deliberately narrow: the declared PDF root is source
for a PDF document, while PDFs produced inside a TeX project remain build
artifacts. This distinction is a counterfactual requirement, not an extension
allowlist change.
