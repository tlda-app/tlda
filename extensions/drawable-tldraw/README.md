# Drawable (TLDraw)

> **Fair warning:** This was vibe-coded with Claude Code. The author has not read the source.

A Quarto filter that adds per-figure TLDraw drawing canvases to standalone HTML pages. Click the pencil button on any figure to draw on it.

This is an independent extension, not a tlda dependency. It shares group specification conventions with tlda (how you mark up figure groups) but has no runtime overlap. Use this when you want lightweight per-figure drawing in normal Quarto HTML output, without the full tlda annotation system.

## Installation

```bash
quarto add davidahirshberg/quarto-drawable-tldraw
```

Or copy the `drawable-tldraw/` directory into your project's `_extensions/` folder.

## Usage

Add to your `_quarto.yml` format filters:

```yaml
format:
  html:
    filters:
      - drawable-tldraw
```

### Automatic wrapping

By default, all figures with SVG or image content get a drawing overlay. The overlay initializes lazily on first click (TLDraw only loads when you actually draw).

### Manual `.drawable` class

For explicit control, wrap content in a `.drawable` div:

```markdown
::: {.drawable}
![](my-figure.svg)
:::
```

### Linked camera groups

Group multiple figures so pan/zoom is synchronized across them:

```markdown
::: {.linked-cameras}
![](panel-a.svg)

![](panel-b.svg)
:::
```

Zooming into one panel zooms all panels in the group.

### Image-toggle integration

Add `.drawable` to an `.image-toggle` div to get drawing overlays on scrollytelling figures:

```markdown
::: {.image-toggle .drawable}
::: {.step}
![](step1.svg)
Explanation for step 1.
:::
:::
```

## Building from source

The pre-built `drawable.js` is committed to the repo. To rebuild from TypeScript source:

```bash
cd extensions/drawable-tldraw
npm install
npm run build
```

## Requirements

- Quarto >= 1.4.0
- HTML output format
