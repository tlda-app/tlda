# tlda Quarto Config Template

Template `_quarto-tlda.yml` for rendering Quarto projects to tlda.

## Setup

1. Copy `_quarto-tlda.yml` into your Quarto project root (alongside `_quarto.yml`)
2. Install required extensions:
   ```bash
   quarto add davidahirshberg/quarto-inline-svg
   ```
3. Edit the config: set your book title, chapters, and any project-specific settings
4. Render: `quarto render --profile tlda`
5. Push to tlda: `tlda create my-project --format html --dir _book-tlda`

## What this config does

- Outputs to `_book-tlda/` to keep it separate from your normal build output
- Uses `inline-svg` filter so SVG figures render correctly in tlda's iframe viewer
- Disables MathJax accessibility features that conflict with iframe embedding
- Configures R/knitr to produce SVG plots with transparent backgrounds (for dark mode)
- Disables resource embedding (tlda serves assets directly)

## Single file vs book

For a **single `.qmd` file** (not a book project), simplify the config:

```yaml
# _quarto-tlda.yml (single file)
filters:
  - inline-svg

format:
  html:
    fig-format: svg
    embed-resources: false
    html-math-method: mathjax
```

Render with `quarto render myfile.qmd --profile tlda`, then push the output directory.
