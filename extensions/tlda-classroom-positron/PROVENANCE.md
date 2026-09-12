# Where this source came from

**Until 0.2.4 this directory was not the extension students run.** It was version
`0.1.0` under publisher `tlda`, a namespace that does not exist on OpenVSX. What
students install is `tlda-labs.tlda-classroom`, published manually to OpenVSX.
The two diverged for months, and a fix written here reached
nobody.

`0.2.4` closes that: `src/` is the published `0.2.3` source plus the Submit
command. **This directory is now the source of the published extension.** Keep it
that way — if a version is ever published from somewhere else, the next person to
read this file will believe something false.

## How 0.2.3's source was recovered

The published VSIX carries complete unminified source. It was fetched from
OpenVSX and checked against the checksum OpenVSX advertises for it:

```sh
curl -sSL -o pub.vsix https://open-vsx.org/api/tlda-labs/tlda-classroom/0.2.3/file/tlda-labs.tlda-classroom-0.2.3.vsix
curl -sSL https://open-vsx.org/api/tlda-labs/tlda-classroom/0.2.3/file/tlda-labs.tlda-classroom-0.2.3.sha256
shasum -a 256 pub.vsix
```

Both were `eb1f58be292e64b87c047fd02ded91db3ccd13da874acd891360ff735e1acba1`
on 2026-08-31.

| file | relationship to published 0.2.3 |
|---|---|
| `src/images.js` | byte-identical (`cmp`) |
| `src/submission.js` | byte-identical (`cmp`) |
| `src/extension.js` | 0.2.3 plus the Submit command |
| `src/classroom-upload.js` | this repo's, unchanged since `c09e3943d` |

## Publishing

There is no publish path in this repository — packaging is
`npx @vscode/vsce package`, and publishing is done manually
with the OpenVSX token. **Bump `version` in `package.json` every time**: OpenVSX
refuses a re-publish of an existing version, and a silent failure there is
exactly how 0.1.0 came to sit here looking shipped.

## Linting

The repository's `eslint.config.js` covers `.ts`, `.tsx` and `.mjs` only, so no
`.js` in this directory is linted by `npm run lint`. Lint it explicitly with a
config that sets `no-undef`, and confirm that config reports a planted undefined
before believing a clean result.
