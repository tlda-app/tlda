# Image Toggle

A Quarto filter for scrollytelling figures. Create multi-step image sequences where text on one side drives image changes on the other.

## Installation

```bash
quarto add davidahirshberg/quarto-image-toggle
```

Or copy the `image-toggle/` directory into your project's `_extensions/` folder.

## Usage

Add to your `_quarto.yml`:

```yaml
filters:
  - image-toggle
```

Then in your `.qmd` file, create an `.image-toggle` div with step divs inside:

```markdown
::: {.image-toggle}

::: {.step}
![](step1.svg)

Here's what happens first.
:::

::: {.step}
![](step2.svg)

Now the figure changes to show the next state.
:::

:::
```

Each `.step` contains an image and explanatory text. As the reader scrolls through the text, the figure panel updates to show the corresponding image.

## Layout

The filter renders a two-column layout:
- **Figure column** (left): sticky, shows the current step's image
- **Text column** (right): scrollable, triggers image transitions at step boundaries

## Requirements

- Quarto >= 1.4.0
- Works with HTML output formats
