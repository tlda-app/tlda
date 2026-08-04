# tlda Quarto project

This extension provides the native `tlda` Quarto project type. A render writes
an ordered `tlda-manifest.json` beside the HTML output so tlda can preserve the
project's page order and source coordinates.

## Start a project

```sh
quarto use template tlda-app/tlda/extensions/tlda
```

For an existing Quarto book, install the extension and select the project type:

```sh
quarto add tlda-app/tlda/extensions/tlda
```

```yaml
project:
  type: tlda
```

Keep ordinary Quarto book configuration, including `book.chapters`, in
`_quarto.yml`. Link the source project to tlda as a qmd project; tlda performs
the render and consumes the generated manifest.

```sh
tlda project link my-project . --main index.qmd --format qmd
```

The manifest contract is versioned. Version 1 has `kind: tlda` and an ordered
`pages` array. Each page names its rendered HTML file, display title, and qmd
source coordinate:

```json
{
  "version": 1,
  "kind": "tlda",
  "pages": [
    {
      "file": "index.html",
      "title": "Introduction",
      "source": {
        "type": "project-source",
        "format": "qmd",
        "file": "index.qmd"
      }
    }
  ]
}
```

Classroom behavior belongs to the separate `tlda-classroom` project type; it
is not part of this generic contract.
