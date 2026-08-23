import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { scanTexDependencyClosure } from './tex-deps.mjs'

test('local document class and bibliography style belong to the TeX dependency closure', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-tex-deps-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'paper.tex'), String.raw`\documentclass[lineno]{biometrika}
\bibliographystyle{biometrika}
\begin{document}Paper\end{document}
`)
  writeFileSync(join(dir, 'biometrika.cls'), 'class\n')
  writeFileSync(join(dir, 'biometrika.bst'), 'style\n')

  assert.deepEqual(scanTexDependencyClosure('paper.tex', dir).files, [
    'biometrika.bst',
    'biometrika.cls',
    'paper.tex',
  ])
})

test('local class and package dependencies are followed transitively', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-tex-deps-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'main.tex'), String.raw`\documentclass{local}\begin{document}x\end{document}`)
  writeFileSync(join(dir, 'local.cls'), String.raw`\RequirePackage{first}`)
  writeFileSync(join(dir, 'first.sty'), String.raw`\usepackage{second}`)
  writeFileSync(join(dir, 'second.sty'), '')

  const closure = scanTexDependencyClosure('main.tex', dir)
  assert.deepEqual(closure.files, ['first.sty', 'local.cls', 'main.tex', 'second.sty'])
  assert.deepEqual(closure.missing, [])
})

test('references in an included file may resolve from the project root', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-tex-deps-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'main.tex'), String.raw`\input{sections/body}`)
  mkdirSync(join(dir, 'sections'))
  mkdirSync(join(dir, 'figures'))
  writeFileSync(join(dir, 'sections/body.tex'), String.raw`\includegraphics{figures/result}`)
  writeFileSync(join(dir, 'figures/result.pdf'), '')

  const closure = scanTexDependencyClosure('main.tex', dir)
  assert.deepEqual(closure.files, ['figures/result.pdf', 'main.tex', 'sections/body.tex'])
  assert.deepEqual(closure.missing, [])
})

// LaTeX resolves a reference against the COMPILATION directory — the main
// file's — and the resolver tried the including file's directory and the project
// root, which are the same thing as the compilation directory only when the main
// file sits at the project root. Every probe passed for that reason. One
// directory deeper, a figure referenced from a subfile resolved to nothing and
// was dropped from the revision, so it never reached the server. Most papers are
// shaped that way.
test('a figure referenced from a subfile resolves against the document root, not the project root', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-tex-deps-nested-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'sub/sections'), { recursive: true })
  mkdirSync(join(dir, 'sub/figures'), { recursive: true })
  // The document root is one level down, which is the whole point.
  writeFileSync(join(dir, 'sub/paper.tex'), String.raw`\includegraphics{figures/cover.png}
\input{sections/body}`)
  writeFileSync(join(dir, 'sub/sections/body.tex'), String.raw`\includegraphics{figures/plot.png}`)
  // `cover` is the control: referenced from the root file, it resolved before
  // this fix and must still resolve after it. Without it a regression that
  // resolved nothing at all would still satisfy the assertion below.
  writeFileSync(join(dir, 'sub/figures/cover.png'), 'cover')
  writeFileSync(join(dir, 'sub/figures/plot.png'), 'plot')

  const closure = scanTexDependencyClosure('sub/paper.tex', dir)
  assert.deepEqual(closure.files, [
    'sub/figures/cover.png',
    'sub/figures/plot.png',
    'sub/paper.tex',
    'sub/sections/body.tex',
  ])
})

// Containment is a real boundary, not a convenience, and adding a resolution
// base must not open one. A reference that climbs out of the project is not a
// member however it is resolved.
test('a subfile reference that escapes the project is still not a member', t => {
  const parent = mkdtempSync(join(tmpdir(), 'tlda-tex-deps-escape-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const dir = join(parent, 'proj')
  mkdirSync(join(dir, 'sub/sections'), { recursive: true })
  // The escaping target MUST exist, and must sit just outside the project root,
  // or this test passes for the wrong reason: a reference to nothing is excluded
  // whether containment is enforced or not. Written this way the resolver's
  // project-root base resolves it to a real file at `../outside.png`, so only
  // the containment check can keep it out — and removing that check turns this
  // test red, which was verified.
  writeFileSync(join(parent, 'outside.png'), 'outside')
  writeFileSync(join(dir, 'sub/paper.tex'), String.raw`\input{sections/body}`)
  writeFileSync(join(dir, 'sub/sections/body.tex'), String.raw`\includegraphics{../outside.png}`)

  const closure = scanTexDependencyClosure('sub/paper.tex', dir)
  assert.deepEqual(closure.files, ['sub/paper.tex', 'sub/sections/body.tex'])
  assert.equal(closure.files.some(f => f.includes('outside')), false)
})

test('an SVG-authored figure excludes its generated PDF and bounding-box companions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-tex-deps-svg-source-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'figures'))
  writeFileSync(join(dir, 'main.tex'), String.raw`\includegraphics{figures/errors-combined-error}`)
  writeFileSync(join(dir, 'figures/errors-combined-error.pdf'), '')
  writeFileSync(join(dir, 'figures/errors-combined-error.svg'), '<svg viewBox="0 0 100 100"/>')
  writeFileSync(join(dir, 'figures/errors-combined-error.bb'), '%%BoundingBox: 0 0 100 100\n')

  assert.deepEqual(scanTexDependencyClosure('main.tex', dir).files, [
    'figures/errors-combined-error.svg',
    'main.tex',
  ])
})
