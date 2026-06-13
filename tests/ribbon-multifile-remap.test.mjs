// Deterministic test of the file-aware ribbon remap (bug 1: "balloon on edit").
//
// Reproduces the real failure: in a multi-file (\input) project the synctex
// lookup keys lines as "file.tex:N" for inputs and bare "N" for the main file.
// The old line->Y index stripped the filename, so the SAME line number from two
// different files collapsed into one bucket. On remap, taking the min/max canvas-Y
// over a segment's line range then swept in the same-numbered line from the OTHER
// file — on a far page — and stretched the band across the whole document.
//
// LINE_DATA below is real bregman synctex output: body.tex lines 104-115 live on
// page 2, and the identical bare line numbers (the main file) live on page 20.
// Inlined so the test is self-contained (no dependency on a build doc).
//
// Run: node tests/ribbon-multifile-remap.test.mjs

import assert from 'assert'

// Real (file, line, page, pdfY) tuples from bregman-lower-bound-lookup.json.
const LINE_DATA = [
  // body.tex region (page 2) — where a mark would actually be drawn.
  { file: 'body.tex', line: 104, page: 2, y: 198.2 },
  { file: 'body.tex', line: 106, page: 2, y: 186.2 }, // note: 106 sits ABOVE 104 (non-monotonic)
  { file: 'body.tex', line: 108, page: 2, y: 222.3 },
  { file: 'body.tex', line: 111, page: 2, y: 246.4 },
  { file: 'body.tex', line: 112, page: 2, y: 246.4 },
  { file: 'body.tex', line: 113, page: 2, y: 268.6 },
  // SAME line numbers in the main file (bare keys) — page 20, far away.
  { file: '', line: 104, page: 20, y: 485.2 },
  { file: '', line: 106, page: 20, y: 507.1 },
  { file: '', line: 108, page: 20, y: 547.1 },
  { file: '', line: 111, page: 20, y: 565.6 },
  { file: '', line: 112, page: 20, y: 565.6 },
  { file: '', line: 113, page: 20, y: 577.6 },
]

// Stacked-canvas transform: pages stack top-to-bottom, so canvasY is monotonic
// across the document. pdfToCanvas in the app is monotonic the same way; the
// exact stride is irrelevant — what matters is that page 2 and page 20 are far
// apart, which is the whole point of the conflation bug.
const PAGE_STRIDE = 800
const canvasY = (e) => (e.page - 1) * PAGE_STRIDE + e.y

const index = LINE_DATA
  .map(e => ({ file: e.file, line: e.line, canvasY: canvasY(e) }))
  .sort((a, b) => a.canvasY - b.canvasY)

// ---- OLD logic: range min/max over ALL files (filename stripped) ----
function extentOld(loLine, hiLine) {
  let top = Infinity, bottom = -Infinity
  for (const e of index) {
    if (e.line < loLine || e.line > hiLine) continue
    if (e.canvasY < top) top = e.canvasY
    if (e.canvasY > bottom) bottom = e.canvasY
  }
  return { top, bottom }
}

// ---- NEW logic: range min/max restricted to the segment's own file(s) ----
function extentNew(files, loLine, hiLine) {
  let top = Infinity, bottom = -Infinity
  for (const e of index) {
    if (!files.has(e.file)) continue
    if (e.line < loLine || e.line > hiLine) continue
    if (e.canvasY < top) top = e.canvasY
    if (e.canvasY > bottom) bottom = e.canvasY
  }
  return { top, bottom }
}

const height = ({ top, bottom }) => bottom - top

let failures = 0
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}

// A mark the user drew on body.tex lines 104-113 (page 2). Its true extent is
// the body.tex cluster only — roughly one page-fraction tall.
const lo = 104, hi = 113
const trueTop = Math.min(...index.filter(e => e.file === 'body.tex' && e.line >= lo && e.line <= hi).map(e => e.canvasY))
const trueBottom = Math.max(...index.filter(e => e.file === 'body.tex' && e.line >= lo && e.line <= hi).map(e => e.canvasY))
const trueHeight = trueBottom - trueTop

const oldE = extentOld(lo, hi)
const newE = extentNew(new Set(['body.tex']), lo, hi)

console.log(`\nMark on body.tex lines ${lo}-${hi} (page 2). True extent height ≈ ${trueHeight.toFixed(1)}px`)
console.log('  OLD (file-blind):', oldE, 'height', height(oldE).toFixed(1))
console.log('  NEW (file-aware):', newE, 'height', height(newE).toFixed(1))

check('OLD balloons across pages (reproduces the bug)', height(oldE) > 10 * trueHeight)
check('OLD spans into page 20 (bottom past page-19 offset)', oldE.bottom > 19 * PAGE_STRIDE)
check('NEW stays on page 2 (bottom below page-2 offset + stride)', newE.bottom < 2 * PAGE_STRIDE)
check('NEW matches the true body.tex extent', Math.abs(height(newE) - trueHeight) < 0.5)
check('NEW is normalized (top < bottom) despite within-file non-monotonicity', newE.top < newE.bottom)

console.log('')
assert.strictEqual(failures, 0, `${failures} check(s) failed`)
console.log('All checks passed.')
