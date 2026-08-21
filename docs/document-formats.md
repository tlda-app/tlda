# Document-format architecture

A tlda document has three independent axes:

| axis | examples | owns |
| --- | --- | --- |
| source format | `tex`, `qmd`, `md`, `pdf`, `html` | authored root and source discovery |
| renderer | `latex`, `quarto`, `markdown`, `identity` | build routing |
| document format | `paged`, `html`, `slides` | viewer and interaction model |

These are stored as `sourceFormat`, `renderer`, and `documentFormat`, and they
are authoritative for source and build identity. Runtime startup rejects records without all
three axes or with the removed `format` field; there is no compatibility or
startup migration path.

Every builder writes `output/document-manifest.json`. It identifies the source
root and renderer, the document format, ordered display pages with dimensions,
assets, optional searchable-text geometry, and the available source-mapping
mode. Its `view` capabilities are the sole runtime viewer behavior contract.

Renderer adapters are registered in `server/lib/build-adapter-registry.mjs`.
Each returns one `BuildResult`; `buildDocument()` is the sole completion
boundary that records the version disposition, publishes the manifest and
project state, signals reload, and reports success. The worker and build
decision code ask the registry and contain no format switch.

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
