# Input Formats

tlda supports several input formats. Each has its own build pipeline, viewer behavior, and feature set.

## Format Comparison

| Feature | SVG (LaTeX) | HTML (Quarto) | Slides (reveal.js) | Book (composite) |
|---------|-------------|---------------|---------------------|-----------------|
| Source | `.tex` | `.html` (pre-rendered) | `.html` (reveal.js) | existing projects |
| Build | latexmk → dvisvgm | copy + inject | parse slides | none |
| Navigation | scroll | pages (tabs) | scroll | member tabs |
| Source anchoring | synctex | no | no | per-member |
| Proof reader | yes | no | no | per-member |
| Dark mode | yes | yes | yes | per-member |
| Figure overlays | patched from DVI | detected by bridge | no | per-member |
| Math notes | yes | yes | yes | yes |
| Drawing/highlight | yes | yes | yes | yes |

## SVG (LaTeX) — default

The primary format. LaTeX source is compiled to DVI, converted to SVG pages, and displayed natively in TLDraw.

```bash
tlda create paper --dir /path/to/tex/project
```

Features:
- Source-anchored annotations via synctex (annotations track source lines, survive rebuilds)
- Proof reader mode (`r` key) with cross-page statement overlays
- Figure patching: SVG figures inlined, raster images embedded as base64
- Custom LaTeX macros available in math notes
- Hot-reload on save via watcher

## HTML (Quarto) — `--format html`

Multi-chapter HTML from Quarto book renders. Each chapter loads in an iframe with a bridge script that integrates it into the TLDraw canvas.

```bash
quarto render --profile tlda
tlda create textbook --format html --dir _book-tlda
```

Features:
- One TLDraw page per chapter
- Cross-chapter link navigation
- Scrollytelling figure support (with `image-toggle` extension)
- Dark mode with semantic color preservation
- Auto-sizing iframes
- Browse tool for interacting with iframe content

Requires: `inline-svg` Quarto extension. See [Quarto HTML guide](quarto-html.md).

## Slides (reveal.js) — `--format slides`

Reveal.js HTML decks rendered as a vertical stack of slides in TLDraw.

```bash
tlda create deck --format slides --dir /path/to/slides
```

Features:
- Slides stacked vertically on a single TLDraw page
- Edge tap zones for fragment stepping
- Reveal.js navigation disabled (TLDraw handles it)
- Dark mode

## Book (composite) — `tlda book`

Groups existing tlda projects into a tabbed collection. Each member keeps its own sync room and annotations.

```bash
tlda book course-module --members lecture1,lecture2,lab1
```

Features:
- Tab bar to switch between members
- Each member retains its original format and features
- Shared viewer URL

## Other Formats

### PNG (raster)

Raster images displayed as pages. Minimal feature set — no text selection, no source anchoring. Created via API with `format: "png"`.

### Diff (side-by-side)

Two versions of a LaTeX document shown side-by-side with change highlighting. Created via `build-diff.sh` script, not the standard CLI. Features triage UI with keep/revert/discuss status dots.
