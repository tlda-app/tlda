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
tlda doc link talk talk.qmd --format slides
```

The tlda link step links the repository containing `talk.qmd`, derives the
rendered `talk.html` entrypoint from that file, follows local HTML/CSS
references, uploads only that artifact closure, and generates `page-info.json`
for the viewer. It does not upload caches or unused asset directories.
