# Quarto HTML Projects

tlda can display Quarto-rendered HTML as annotatable documents. Each HTML chapter becomes a page in the TLDraw canvas, with full support for annotations, dark mode, cross-chapter navigation, and figure overlays.

## Quick Start

```bash
# 1. Install the inline-svg extension in your Quarto project
cd /path/to/your/project
quarto add davidahirshberg/quarto-inline-svg

# 2. Create a _quarto-tlda.yml alongside your _quarto.yml
#    (Quarto profiles are named _quarto-{profile}.yml — the "tlda" suffix becomes the profile name)
#    See extensions/tlda-quarto-config/_quarto-tlda.yml for a template, or write your own.

# 3. Render with the tlda profile
quarto render --profile tlda

# 4. Create the tlda project and push
tlda create my-book --format html --dir _book-tlda

# 5. Open
tlda open my-book
```

## How It Works

tlda doesn't render Quarto files — it displays pre-rendered HTML. The pipeline is:

```
.qmd files → quarto render → HTML chapters → tlda create --format html → viewer
```

Each HTML chapter is loaded in an iframe on the TLDraw canvas. A bridge script injected by the server handles:

- **Navigation stripping**: removes Quarto sidebar, navbar, and footer
- **Height reporting**: iframes auto-size to their content
- **Figure detection**: finds `<img>` and inlined SVGs, creates figure overlays
- **Dark mode**: CSS inversion with semantic color preservation
- **Link interception**: in-document links navigate between chapters smoothly
- **MathJax**: custom macros are injected before MathJax loads

## Required Extensions

### inline-svg (required)

Inlines SVG images at build time so they're part of the HTML DOM. Without this, SVGs loaded via `<img>` tags are opaque to the bridge script and won't support:
- Dark mode color preservation
- Figure overlay detection
- Per-element CSS targeting

### image-toggle (optional)

Scrollytelling figures: text on one side drives image changes on the other. The bridge script detects `.image-toggle` regions and reports them to the viewer for overlay support.

## Book vs Single File

### Book project (multi-chapter)

Use `project: type: book` in your `_quarto-tlda.yml`. Each chapter becomes a separate page in the viewer with its own tab.

```yaml
project:
  type: book
  output-dir: _book-tlda

book:
  title: "My Book"
  chapters:
    - index.qmd
    - part: part1.qmd
      chapters:
        - chapter1.qmd
        - chapter2.qmd
```

After rendering, the output directory contains one HTML file per chapter plus `site_libs/` with Quarto framework files.

### Single file

For a single `.qmd`, you don't need a book project:

```bash
quarto render lecture.qmd --profile tlda
tlda create lecture --format html --dir _output/
```

The viewer loads it as a single-page document.

## Config Essentials

These settings matter for tlda compatibility:

| Setting | Value | Why |
|---------|-------|-----|
| `fig-format` | `svg` | Sharp rendering, dark mode support |
| `embed-resources` | `false` | tlda serves assets from the output directory |
| `html-math-method` | `mathjax` | Bridge script configures MathJax for iframe embedding |
| `filters: [inline-svg]` | required | SVGs must be inlined for figure detection and dark mode |

## File Watcher

For iterative development, use the watcher to auto-push on changes:

```bash
# Terminal 1: watch Quarto source and re-render
quarto preview --profile tlda

# Terminal 2: watch rendered output and push to tlda
tlda watch my-book --dir _book-tlda
```

Or use `tlda watch-all` if the project's `sourceDir` is set.

## Troubleshooting

**Blank pages**: Check that `embed-resources: false` is set. Embedded resources create self-contained HTML that's too large for iframe loading.

**Missing figures**: Make sure `inline-svg` filter is listed in your config. Without it, SVG figures won't be detected by the bridge script.

**MathJax errors**: The `_quarto-tlda.yml` template disables MathJax accessibility features (`assistiveMml`, `collapsible`, `explorer`) that interfere with iframe embedding. If you have custom MathJax config in your `.qmd`, make sure it doesn't re-enable these.

**Dark mode colors wrong**: Add semantic colors to the `SEMANTIC_COLORS` table in `inline-svg.lua`. Colors listed there get a `darkmode-invariant` CSS class that exempts them from dark mode inversion.
