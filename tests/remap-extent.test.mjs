// Deterministic test of the ribbon remap fix against REAL synctex lookup data.
//
// Reproduces mode #1 (collapse/inversion): a segment whose stored
// startLine/endLine resolve — via independent nearest-line lookup — to inverted
// canvas-Y, so the renderer (height = max(2, y2-y1)) flattens it to a 2px sliver.
//
// The lookup below is the actual main-lookup.json produced by building the
// `ribbon-state-test` doc (clone of the ribbon-c test surface). It contains a
// genuinely non-monotonic region: line 46 -> y405.8 sits BELOW line 47 -> y392.2.
//
// Run: node tests/remap-extent.test.mjs

import { readFileSync } from 'fs'
import assert from 'assert'

const lookup = JSON.parse(readFileSync(
  new URL('../../../server/projects/ribbon-state-test/output/main-lookup.json', import.meta.url)
))

// Build the same line->canvasY index remap uses (here canvasY == synctex y;
// the pdf->canvas transform is monotonic so it preserves ordering/inversions).
const index = Object.entries(lookup.lines)
  .map(([k, v]) => ({ line: parseInt(k.includes(':') ? k.split(':')[1] : k, 10), canvasY: v.y }))
  .filter(e => !isNaN(e.line))
  .sort((a, b) => a.canvasY - b.canvasY)

// ---- OLD logic: resolve the two endpoints independently ----
function lineToCanvasY(index, lineNum) {
  if (index.length === 0) return null
  let best = null, bestDiff = Infinity
  for (const e of index) {
    const diff = Math.abs(e.line - lineNum)
    if (diff === 0) return e.canvasY
    if (diff < bestDiff) { bestDiff = diff; best = e }
  }
  return best?.canvasY ?? null
}
function remapOld(seg) {
  return { y1: lineToCanvasY(index, seg.startLine), y2: lineToCanvasY(index, seg.endLine) }
}

// ---- NEW logic: min/max canvas-Y over the whole [lo,hi] line range ----
function lineRangeToCanvasYExtent(index, loLine, hiLine) {
  if (index.length === 0) return null
  let top = Infinity, bottom = -Infinity
  for (const e of index) {
    if (e.line < loLine || e.line > hiLine) continue
    if (e.canvasY < top) top = e.canvasY
    if (e.canvasY > bottom) bottom = e.canvasY
  }
  if (top === Infinity) {
    const a = lineToCanvasY(index, loLine), b = lineToCanvasY(index, hiLine)
    if (a == null || b == null) return null
    return { top: Math.min(a, b), bottom: Math.max(a, b) }
  }
  return { top, bottom }
}
function remapNew(seg) {
  const lo = Math.min(seg.startLine, seg.endLine)
  const hi = Math.max(seg.startLine, seg.endLine)
  const e = lineRangeToCanvasYExtent(index, lo, hi)
  return { y1: e.top, y2: e.bottom }
}

const renderedHeight = ({ y1, y2 }) => Math.max(2, y2 - y1) // mirrors UnderstandingLineShape.tsx:278
const COLLAPSED = (r) => renderedHeight(r) <= 2

let failures = 0
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}

// Case A — reversed endpoints (the live `351->292` corruption shape, mode #1).
// Proof region spans lines 38..47.
const reversed = { startLine: 47, endLine: 39, status: 'approved' }
const oldA = remapOld(reversed)
const newA = remapNew(reversed)
console.log('\nCase A: reversed segment {startLine:47, endLine:39}')
console.log('  OLD:', oldA, 'rendered height', renderedHeight(oldA).toFixed(1))
console.log('  NEW:', newA, 'rendered height', renderedHeight(newA).toFixed(1))
check('OLD collapses the band (reproduces the bug)', COLLAPSED(oldA))
check('NEW keeps the band visible', !COLLAPSED(newA))
check('NEW is normalized (y1 < y2)', newA.y1 < newA.y2)
check('NEW spans the whole proof region (>= 50px)', renderedHeight(newA) >= 50)

// Case B — forward segment over the same non-monotonic region. Even drawn
// top->bottom, independent endpoints can still invert; range-extent cannot.
const forward = { startLine: 39, endLine: 47, status: 'approved' }
const oldB = remapOld(forward)
const newB = remapNew(forward)
console.log('\nCase B: forward segment {startLine:39, endLine:47}')
console.log('  OLD:', oldB, 'rendered height', renderedHeight(oldB).toFixed(1))
console.log('  NEW:', newB, 'rendered height', renderedHeight(newB).toFixed(1))
check('NEW normalized + visible', newB.y1 < newB.y2 && !COLLAPSED(newB))

// Case C — tiny 1-line non-monotonic pair (line 46 below line 47).
const tiny = { startLine: 46, endLine: 47, status: 'approved' }
const oldC = remapOld(tiny)
const newC = remapNew(tiny)
console.log('\nCase C: {startLine:46, endLine:47} (46 is BELOW 47 in synctex)')
console.log('  OLD:', oldC, 'rendered height', renderedHeight(oldC).toFixed(1))
console.log('  NEW:', newC, 'rendered height', renderedHeight(newC).toFixed(1))
check('OLD inverts (y1 > y2)', oldC.y1 > oldC.y2)
check('NEW normalized (y1 < y2)', newC.y1 < newC.y2)

console.log('')
assert.strictEqual(failures, 0, `${failures} check(s) failed`)
console.log('All checks passed.')
