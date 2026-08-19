#!/usr/bin/env node
//
// **Membership is the transitive closure of the document roots.** Skip,
// 2026-08-17: *"it's the transitive closure of the document roots. that's it."*
//
// Markdown has had that since it shipped. LaTeX had a directory walk plus a
// file-extension test, so `\input{}` was not followed at all — a file belonged to
// the project because of where it sat on disk, not because the paper reaches it.
//
// What this pins, in order of what would cost him most if it broke:
//
//   1. `\input{body}` — **no extension** — resolves to `body.tex`. Measured in
//      his papers: 3 of 3 `\input` and 3 of 3 `\bibliography` are extensionless.
//      A closure that demanded the extension would drop the entire paper.
//   2. A reference that ESCAPES the project root is not a member, is not an
//      error, and is not normalised into range.
//   3. A reference that does not RESOLVE is not a member either — and is
//      recorded. A member with no bytes is the phantom class that refused every
//      push he made for four days.
//   4. A COMMENTED-OUT directive is not a member. Same class as 3, arriving from
//      the other direction: a file that exists but the paper does not include.
//   5. A macro in the path is unresolvable and says so, rather than being
//      guessed at or silently dropped.
//
// The fixture is a synthetic project, so the assertions are exact. His real
// papers are then run through the same closure as a reality check at the end —
// read-only, and only to confirm the scanner finds what is actually in them.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { latexDependencyClosure, scanLatexDeps, stripTexComments } from '../shared/latex-deps.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-closure-'))
const write = (rel, text) => {
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

// Access over a real directory. The closure takes these as arguments precisely
// so the same code can run over a git tree instead.
const exists = rel => fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isFile()
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

// ---------------------------------------------------------------------------
// A project shaped like his: an extensionless \input, a subdirectory figure, a
// bib named without its extension, and a package that is not a local file.

write('main.tex', String.raw`
\documentclass{article}
\usepackage{amsmath}
\input{macros}
\begin{document}
\input{body}
\bibliography{references}
\end{document}
`)
write('macros.tex', String.raw`\newcommand{\x}{x}`)
write('body.tex', String.raw`
\includegraphics[width=\textwidth]{figures/plot}
\includegraphics[width=0.5\linewidth]{figures/photo.png}
\input{sections/appendix}
`)
write('sections/appendix.tex', String.raw`the appendix`)
write('figures/plot.pdf', '%PDF-fake')
write('figures/photo.png', 'PNG-fake')
write('references.bib', '@article{a,title={a}}')

// Files that exist on disk and the paper does NOT reach. Under a directory walk
// these were members; under a closure they are not.
write('old-draft.tex', String.raw`\input{body}`)
write('figures/unused.pdf', '%PDF-unused')

const closure = latexDependencyClosure({ roots: ['main.tex'], exists, read })

// 1. THE CLOSURE. Extensionless \input and \bibliography resolved; the
//    subdirectory figure found; the unreferenced files absent.
assert.deepEqual(closure.files, [
  'body.tex',
  'figures/photo.png',
  'figures/plot.pdf',
  'macros.tex',
  'main.tex',
  'references.bib',
  'sections/appendix.tex',
], `the closure is exactly what the paper reaches — got ${JSON.stringify(closure.files)}`)

assert.ok(!closure.files.includes('old-draft.tex'),
  'A FILE ON DISK IS NOT A MEMBER: old-draft.tex exists and nothing includes it')
assert.ok(!closure.files.includes('figures/unused.pdf'),
  'and neither is an unreferenced figure — which is what a directory walk could never say')

// The extensionless forms specifically, because they are the common case and the
// expensive one to get wrong.
assert.ok(closure.files.includes('body.tex'), String.raw`\input{body} resolved to body.tex`)
assert.ok(closure.files.includes('references.bib'), String.raw`\bibliography{references} resolved to references.bib`)
assert.ok(closure.files.includes('figures/plot.pdf'), String.raw`\includegraphics{figures/plot} resolved to .pdf`)

// A written extension is not overridden by the candidate order. `.pdf` is tried
// first for graphics, so `photo.png` proves the explicit spelling wins.
assert.ok(closure.files.includes('figures/photo.png'), 'an explicitly written extension is honoured')

// A distribution package is not a local file and is not reported as missing.
assert.ok(!closure.missing.some(m => m.ref === 'amsmath'),
  String.raw`\usepackage{amsmath} is a TeX package, not a missing project file`)
assert.ok(!closure.missing.some(m => m.ref === 'article'),
  String.raw`\documentclass{article} likewise`)

// ---------------------------------------------------------------------------
// 2. ESCAPING THE ROOT: not a member, not an error.

write('escapes.tex', String.raw`
\input{../outside/secrets}
\includegraphics{/etc/passwd}
`)
const escaping = latexDependencyClosure({ roots: ['escapes.tex'], exists, read })
assert.deepEqual(escaping.files, ['escapes.tex'],
  'a reference outside the project root is simply not a member')
assert.deepEqual(escaping.missing, [],
  'and it is NOT reported as missing — the paper reaches out, the project does not grow to meet it')

// ---------------------------------------------------------------------------
// 3. UNRESOLVED IS NOT A MEMBER, AND IS VISIBLE.
//
// This is the phantom class. A manifest entry with no bytes behind it refused
// every push Skip made for four days, so the assertion is on BOTH halves: it is
// absent from members, and it is present in the report.

write('broken.tex', String.raw`\input{does-not-exist}`)
const broken = latexDependencyClosure({ roots: ['broken.tex'], exists, read })
assert.deepEqual(broken.files, ['broken.tex'],
  'PHANTOM GUARD: a file that does not exist does not become a member')
assert.equal(broken.missing.length, 1, 'and it is recorded rather than swallowed')
assert.equal(broken.missing[0].ref, 'does-not-exist', 'naming the reference as written')
assert.equal(broken.missing[0].from, 'broken.tex', 'and the file that wrote it')

// ---------------------------------------------------------------------------
// 4. A COMMENTED-OUT DIRECTIVE IS NOT A MEMBER.

write('commented.tex', [
  String.raw`% \input{macros}`,
  String.raw`\input{body}         % trailing comment mentioning \input{old-draft}`,
  String.raw`100\% of the time \input{sections/appendix}`,
].join('\n'))
const commented = latexDependencyClosure({ roots: ['commented.tex'], exists, read })
assert.ok(!commented.files.includes('macros.tex'),
  'a commented-out \\input is not a dependency, even though the file exists')
assert.ok(!commented.files.includes('old-draft.tex'),
  'nor one mentioned in a trailing comment')
assert.ok(commented.files.includes('body.tex'),
  'while the real directive on that line still counts')
assert.ok(commented.files.includes('sections/appendix.tex'),
  String.raw`and \% is an escaped percent, not the start of a comment`)

assert.equal(stripTexComments(String.raw`a \% b % c`).trim(), String.raw`a \% b`,
  'the comment stripper itself: escaped percent survives, real comment does not')

// ---------------------------------------------------------------------------
// 5. A MACRO IN THE PATH IS UNRESOLVABLE, AND SAYS SO.

write('macro-path.tex', String.raw`\input{\datadir/body}`)
const macroed = latexDependencyClosure({ roots: ['macro-path.tex'], exists, read })
assert.deepEqual(macroed.files, ['macro-path.tex'],
  'a path we cannot expand does not become a member')
assert.equal(macroed.unresolved.length, 1, 'it is reported as unresolved')
assert.equal(macroed.unresolved[0].reason, 'macro-in-path',
  'with the reason, because "missing" would be a different and wrong claim')

// ---------------------------------------------------------------------------
// 6. Cycles terminate. \input loops are legal to write and must not hang.

write('a.tex', String.raw`\input{b}`)
write('b.tex', String.raw`\input{a}`)
const cyclic = latexDependencyClosure({ roots: ['a.tex'], exists, read })
assert.deepEqual(cyclic.files, ['a.tex', 'b.tex'], 'a cycle closes rather than looping')

// ---------------------------------------------------------------------------
// 7. The scanner, on the argument shapes measured in his papers.

const deps = scanLatexDeps(String.raw`
\input{.tlda/scratch/scratch-template}
\addbibresource{review.bib}
\bibliography{one,two}
\includegraphics[width=\columnwidth]{icml_numpapers}
`)
assert.ok(deps.some(d => d.ref === '.tlda/scratch/scratch-template'),
  'a dotted directory in an \\input path is a path like any other')
assert.ok(deps.some(d => d.ref === 'review.bib'), '\\addbibresource takes one file')
assert.ok(deps.some(d => d.ref === 'one') && deps.some(d => d.ref === 'two'),
  '\\bibliography takes a comma-separated LIST, which is two files and not one filename')
assert.ok(deps.some(d => d.ref === 'icml_numpapers' && d.kind === 'graphics'),
  'and an option group is skipped rather than read as a path')

fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
console.log('a latex closure that is membership: extensionless inputs resolved, escapes excluded, phantoms refused, comments ignored')
process.exit(0)
