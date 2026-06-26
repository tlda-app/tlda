# tlda RevealJS Quarto Format

`tlda-revealjs` is a Quarto custom format for RevealJS decks that are meant to
be consumed by tlda's `slides` document format.

## Use

Install or copy this extension into a Quarto project, then use:

```yaml
format:
  tlda-revealjs:
    theme: ["class.scss"]
```

The extension contributes a `revealjs` format under the Quarto custom-format
name `tlda-revealjs`. The extension directory is named `tlda` rather than
`tlda-revealjs` because Quarto appends the base format suffix.

## Render and link

```sh
quarto render talk.qmd --to tlda-revealjs
tlda doc link talk --format slides --dir .
```

The tlda link step copies the rendered deck and generates `page-info.json` for
the viewer.
