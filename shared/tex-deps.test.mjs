import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
