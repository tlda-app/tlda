import test from 'node:test'
import assert from 'node:assert/strict'

import { bibliographyRunReason } from '../server/lib/build-bibliography-decision.mjs'

test('runs Biber when biblatex requests it even with a cached bbl', () => {
  const logText = `
Package biblatex Warning: Please (re)run Biber on the file:
(biblatex)                bregman-lower-bound
(biblatex)                and rerun LaTeX afterwards.
`

  assert.equal(bibliographyRunReason({ hasBbl: true, logText }), 'biber-rerun-requested')
})

test('retains missing-bbl and undefined-citation detection', () => {
  assert.equal(bibliographyRunReason({ hasBbl: false, logText: '' }), 'missing-bbl')
  assert.equal(
    bibliographyRunReason({ hasBbl: true, logText: 'LaTeX Warning: Citation `x` undefined.' }),
    'undefined-citations',
  )
})

test('does not run bibliography for an unchanged clean cached bbl', () => {
  assert.equal(bibliographyRunReason({ hasBbl: true, logText: 'Output written on paper.dvi.' }), null)
})
