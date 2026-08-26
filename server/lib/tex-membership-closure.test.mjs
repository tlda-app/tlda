/**
 * A tex document's figures are members of its project, on every path.
 *
 * **The defect.** Membership closed over references for markdown only. Both the
 * CLI link path (`cli/lib/source-files.mjs`) and server membership
 * (`sourceMembershipContext` in `project-store.mjs`) tested the root's
 * extension and `continue`d on anything that was not `.md`, so a `.tex` root
 * dragged in nothing at all. The push path has always branched on the extension
 * and walked `scanTexDependencyClosure` (`daemon/git-project-sync.mjs`), so the
 * two sides disagreed about what a tex document is made of — and the side that
 * disagreed is the one that decides membership.
 *
 * **Why figures specifically.** A `.png` or `.pdf` is reached from a paper by
 * exactly one edge, `\includegraphics`. Nothing else in a project points at it.
 * So a traversal that never runs on tex roots does not lose *some* of a paper,
 * it loses precisely its figures, while the `.tex` and `.bib` still arrive
 * because they are picked up by other means.
 *
 * **The rule this preserves**, Skip 2026-08-26: membership is the include
 * graph, and `xr = link`. `\externaldocument` is not an edge, so a paper that
 * cross-references another does not drag that other paper's sources in as if
 * they were its own parts.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { withReferencedRoots } from '../../cli/lib/source-files.mjs'
import { isSourceFilePath } from '../../shared/source-manifest.mjs'
import { scanTexDependencyClosure } from '../../shared/tex-deps.mjs'

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'texmembership-'))
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return dir
}

const PAPER = String.raw`\documentclass{article}
\begin{document}
\includegraphics{figures/plot.png}
\includegraphics[width=\textwidth]{figures/diagram.pdf}
\input{sections/intro}
\end{document}`

test('the CLI link path reaches a tex root\'s PNG and PDF figures', () => {
  const dir = tree({
    'main.tex': PAPER,
    'sections/intro.tex': String.raw`\section{Intro}`,
    'figures/plot.png': 'png bytes',
    'figures/diagram.pdf': 'pdf bytes',
  })
  try {
    const { referencedRoots } = withReferencedRoots(dir, {
      referencedSourcePaths: [join(dir, 'main.tex')],
    })
    const members = new Set(referencedRoots)
    // The figures are the assertion. Before the fix `referencedRoots` was
    // exactly ['main.tex'] -- the seed and nothing else.
    assert.ok(members.has('figures/plot.png'), `PNG figure is a member (got ${[...members].join(', ')})`)
    assert.ok(members.has('figures/diagram.pdf'), `PDF figure is a member (got ${[...members].join(', ')})`)
    assert.ok(members.has('sections/intro.tex'), 'and the included section too')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a PDF figure is a member through the DECLARED root, with nothing chat-shared', () => {
  // The live bug, and the one that made "a later push loses unchanged TeX
  // figures" true. `isSourceFilePath` admits anything in `referencedRoots`
  // whatever its extension and otherwise falls back to `SOURCE_EXTENSIONS`,
  // which lists `.png .jpg .svg .eps` and NOT `.pdf` -- presumably because a
  // `.pdf` is usually the compiled paper. Measured before the fix:
  //
  //   figures/plot.png      IS source
  //   figures/diagram.pdf   NOT source
  //
  // So the figure was never pushed while the .tex beside it arrived intact.
  //
  // The seed here is the DECLARED root, the way an ordinary project has one.
  // Nothing is chat-shared, because the closure used to run only over
  // chat-shared paths -- which is exactly why an ordinary project got nothing.
  const dir = tree({
    'main.tex': PAPER,
    'sections/intro.tex': String.raw`\section{Intro}`,
    'figures/plot.png': 'png bytes',
    'figures/diagram.pdf': 'pdf bytes',
  })
  writeFileSync(join(dir, 'main.pdf'), 'the compiled paper')
  writeFileSync(join(dir, 'main.aux'), 'aux')
  try {
    // Asserted through `isSourceFilePath`, the predicate that actually decides
    // what gets pushed -- NOT through `referencedRoots`. An earlier version of
    // this test checked the intermediate set, passed, and the real predicate
    // still said NOT source, because `isBuildJunkPath` ran before membership
    // was consulted. Checking the step before the answer is how a green test
    // ships a live bug.
    const ctx = withReferencedRoots(dir, { format: 'svg', mainFile: 'main.tex', referencedRoots: ['main.tex'] })
    assert.equal(isSourceFilePath('figures/diagram.pdf', ctx), true, 'the PDF figure is a source file')
    assert.equal(isSourceFilePath('figures/plot.png', ctx), true, 'and the PNG')
    // The other half of the rule, and the reason .pdf is on the junk list at
    // all. Skip: "a pdf with no corresponding tex or svg is a source" -- the
    // compiled paper is included by nothing, so the graph excludes it without
    // needing to look for a companion file.
    assert.equal(isSourceFilePath('main.pdf', ctx), false, 'the compiled paper is still not a source file')
    assert.equal(isSourceFilePath('main.aux', ctx), false, 'and neither is build junk generally')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('markdown roots keep working unchanged', () => {
  // The guard being widened was load-bearing for markdown. Widening it must not
  // cost the behaviour it already had.
  const dir = tree({
    'notes.md': '# Notes\n\n![fig](img/shot.png)\n',
    'img/shot.png': 'png bytes',
  })
  try {
    const { referencedRoots } = withReferencedRoots(dir, {
      referencedSourcePaths: [join(dir, 'notes.md')],
    })
    assert.ok(new Set(referencedRoots).has('img/shot.png'), 'markdown image is still a member')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('xr is a link: a cross-referenced paper is not swallowed as a member', () => {
  // Preserves Skip's distinction. If \externaldocument were treated as an
  // include, one paper's membership would absorb another paper's entire source
  // tree, and a push of one would carry the other.
  const dir = tree({
    'a.tex': String.raw`\documentclass{article}\usepackage{xr}\externaldocument{b}\begin{document}x\end{document}`,
    'b.tex': String.raw`\documentclass{article}\begin{document}\includegraphics{b-only.png}\end{document}`,
    'b-only.png': 'png bytes',
  })
  try {
    const { referencedRoots } = withReferencedRoots(dir, {
      referencedSourcePaths: [join(dir, 'a.tex')],
    })
    const members = new Set(referencedRoots)
    assert.ok(!members.has('b.tex'), 'the cross-referenced paper is not a member')
    assert.ok(!members.has('b-only.png'), "nor is that paper's figure")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the closure the link path now uses is the one the push path uses', () => {
  // Not a third traversal. Asserted by comparing against the function the
  // daemon calls directly, so the two cannot drift into different answers
  // without this failing.
  const dir = tree({
    'main.tex': PAPER,
    'sections/intro.tex': String.raw`\section{Intro}`,
    'figures/plot.png': 'png bytes',
    'figures/diagram.pdf': 'pdf bytes',
  })
  try {
    const { referencedRoots } = withReferencedRoots(dir, {
      referencedSourcePaths: [join(dir, 'main.tex')],
    })
    const pushSide = new Set(scanTexDependencyClosure('main.tex', dir).files)
    for (const file of pushSide) {
      assert.ok(referencedRoots.includes(file), `link path reaches ${file}, as the push path does`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
