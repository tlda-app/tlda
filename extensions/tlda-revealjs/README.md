# tlda RevealJS

An experimental [Quarto custom format](https://quarto.org/docs/extensions/formats.html)
for RevealJS presentations shown in [tlda](https://github.com/qtm285/tlda).
It supplies the RevealJS defaults that tlda's `slides` document format expects.

## Start a presentation

Create a new presentation from the included template.

```sh
quarto use template davidahirshberg/quarto-tlda-revealjs
```

Or add the format to an existing Quarto project.

```sh
quarto add davidahirshberg/quarto-tlda-revealjs
```

Then select it in the document front matter. You can override ordinary
RevealJS options under `tlda-revealjs`.

```yaml
---
title: "My talk"
format:
  tlda-revealjs:
    theme: [default, class.scss]
---
```

The installed extension belongs in version control with the rest of the
presentation. Quarto stores extensions in each project rather than in a global
package library.

## Render and open it in tlda

Render the presentation first, then link its source directory to a tlda
project.

```sh
quarto render talk.qmd
tlda project link my-talk talk.qmd --format slides
```

The first command creates `talk.html` and its supporting files. The second
links the directory containing `talk.qmd`, derives `talk.html` as the rendered
entry point, and sends that deck and the local assets it references to tlda.
After the project is linked, render again whenever the Quarto source changes;
the tlda daemon watches the rendered files and sends the new deck to the
server.

tlda lays the slides out from left to right on the canvas. Each slide remains
an interactive RevealJS view, so fragments, animations, and HTML widgets can
still run. The format disables RevealJS touch navigation because tlda owns the
surrounding canvas gestures. It also uses SVG figures, leaves supporting
resources unembedded, and configures MathJax for the `physics` and `unicode`
packages.

## Repository layout

```text
README.md
LICENSE
template.qmd
_extensions/
  tlda/
    _extension.yml
```

The extension contributes a `revealjs` format under the custom-format name
`tlda-revealjs`. Its directory is named `tlda` because Quarto adds the base
format suffix to the directory name.

## Requirements

- Quarto 1.2 or newer
- tlda, including a running local daemon, to link and synchronize the rendered
  presentation

This format is experimental. Its defaults and the tlda slides interface may
change while they are being used and tested on real presentations.
