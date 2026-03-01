# Inline SVG

> **Fair warning:** This was vibe-coded with Claude Code. The author has not read the source.

A Quarto filter that inlines all SVG images at build time, replacing `<img src="fig.svg">` with the actual SVG markup in the HTML output.

## Why

- **Dark mode**: Inlined SVGs can be styled with CSS (e.g., `filter: invert()` with counter-filters for semantic colors). External `<img>` SVGs are opaque to CSS.
- **Iframe embedding**: When Quarto HTML is loaded inside an iframe (as in tlda), inlined SVGs are part of the DOM and accessible to the host page for figure detection and overlays.
- **ID namespacing**: Each inlined SVG gets a unique prefix on all `id` attributes, preventing `clipPath` and gradient collisions when multiple SVGs appear on the same page.

## Installation

```bash
quarto add davidahirshberg/quarto-inline-svg
```

Or copy the `inline-svg/` directory into your project's `_extensions/` folder.

## Usage

Add to your `_quarto.yml`:

```yaml
filters:
  - inline-svg
```

All `![](figure.svg)` images will be inlined automatically. Non-SVG images are passed through unchanged.

## Semantic Color Preservation

The filter tags SVG elements that use recognized semantic colors with a `darkmode-invariant` CSS class. This allows dark mode implementations to counter-filter these elements so colors like red, blue, and green retain their meaning after inversion.

The recognized colors are defined at the top of `inline-svg.lua` and can be customized for your project.

## Requirements

- Quarto >= 1.4.0
- SVG files must be accessible at their relative paths during `quarto render`
