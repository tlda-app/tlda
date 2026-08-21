# Document-format architecture

A tlda document has three independent axes:

| axis | examples | owns |
| --- | --- | --- |
| source format | `tex`, `qmd`, `md`, `pdf`, `html` | authored root and source discovery |
| renderer | `latex`, `quarto`, `markdown`, `identity` | build routing |
| document format | `paged`, `html`, `slides` | viewer and interaction model |

These are stored as `sourceFormat`, `renderer`, and `documentFormat`, and they
are authoritative at runtime. On project-store startup, records that predate
the split are migrated once from `format` and QMD's `renderedFormat`, then
persisted. `format` is accepted only at that migration boundary and at legacy
project-creation callers; it is not the runtime routing authority.
Native PDF projects store only the three axes; they do not introduce a `pdf`
project type in the compatibility field.

Every builder writes `output/document-manifest.json`. It identifies the source
root and renderer, the document format, ordered display pages with dimensions,
assets, optional searchable-text geometry, and the available source-mapping
mode. `page-info.json` remains a compatibility projection for the existing HTML
and slide readers while they move to the common manifest.

Format adapters return one build result containing that manifest plus optional
targets and compatibility projections. The common finalizer alone publishes
the manifest, records the authoritative axes and page metadata, marks the build
successful, and signals viewer reload. An adapter cannot report success or
reload viewers independently.

The combinations currently implemented are:

| source | renderer | document | display artifact | source mapping |
| --- | --- | --- | --- | --- |
| TeX | LaTeX | paged | lazy SVG pages | SyncTeX |
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
