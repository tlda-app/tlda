import assert from 'node:assert/strict'
import test from 'node:test'

// The module chain reaches `activeConfig`, which refuses to load without the
// config a tlda server injects into the page — deliberately, "there is no
// fallback by design". Supplying it is what lets this test exercise the REAL
// `canvasToPdf` rather than a copy of its arithmetic, which is the whole point:
// I previously checked my own formula against the screen and learned nothing
// about the function.
;(globalThis as unknown as { window: unknown }).window = globalThis
;(globalThis as unknown as { __TLDA_CONFIG__: unknown }).__TLDA_CONFIG__ = {
  name: 'test',
  database: { http: 'http://localhost', ws: 'ws://localhost' },
  store: { http: 'http://localhost', ws: 'ws://localhost' },
  licenseKey: '',
}

const { canvasToPdf, pdfToCanvas } = await import('../src/synctexAnchor')
const { PDF_WIDTH, PDF_HEIGHT } = await import('../src/layoutConstants')

// Where an annotation is RECORDED, as against where the page is DRAWN. Those
// are two different mappings and fixing the layout did not fix this one.
//
// Before this, `canvasToPdf` scaled every document by the US Letter constants
// and subtracted a fixed 72pt offset. The offset is dvisvgm's — a LaTeX page's
// SVG viewBox starts at -72 — so a PDF, whose pdftocairo SVG starts at 0,0, was
// displaced by 72 points in BOTH axes even on US Letter, where the scale
// happened to be right. On A4 the scale was wrong as well.
//
// A page now carries its own size in points and its own viewBox offset when the
// builder measured them. Absent, the constants apply, which is every LaTeX page.

const CANVAS_W = 800

/** A page as the layout builds it: canvas box, plus point size for a PDF. */
function page(
  yTop: number,
  pts: { w: number, h: number } | null,
) {
  const heightPx = pts ? CANVAS_W * (pts.h / pts.w) : CANVAS_W * (PDF_HEIGHT / PDF_WIDTH)
  return {
    bounds: { x: 0, y: yTop, width: CANVAS_W, height: heightPx },
    width: CANVAS_W,
    height: heightPx,
    ...(pts ? { pdfWidth: pts.w, pdfHeight: pts.h, viewBoxOffset: 0 } : {}),
  }
}

const LETTER = { w: 612, h: 792 }
const A4 = { w: 595.276, h: 841.89 }

test('a Letter PDF records the point actually clicked', () => {
  const p = page(0, LETTER)
  // Dead centre of the page on canvas.
  const got = canvasToPdf(CANVAS_W / 2, p.bounds.height / 2, [p])
  assert.ok(got)
  assert.equal(got!.page, 1)
  assert.ok(Math.abs(got!.x - LETTER.w / 2) < 0.5, `x ${got!.x} should be ${LETTER.w / 2}`)
  assert.ok(Math.abs(got!.y - LETTER.h / 2) < 0.5, `y ${got!.y} should be ${LETTER.h / 2}`)
})

test('an A4 PDF records the point actually clicked, not a Letter-scaled one', () => {
  const p = page(0, A4)
  const got = canvasToPdf(CANVAS_W / 2, p.bounds.height / 2, [p])
  assert.ok(got)
  assert.ok(Math.abs(got!.x - A4.w / 2) < 0.5, `x ${got!.x} should be ${A4.w / 2}`)
  assert.ok(Math.abs(got!.y - A4.h / 2) < 0.5, `y ${got!.y} should be ${A4.h / 2}`)
})

test('the 72pt dvisvgm offset is NOT applied to a PDF', () => {
  // The top-left corner of a PDF page is its origin. Under the old code this
  // returned (-72, -72): a coordinate off the page, for a click on it.
  const p = page(0, LETTER)
  const got = canvasToPdf(0, 0, [p])
  assert.ok(got)
  assert.ok(Math.abs(got!.x) < 0.5, `x ${got!.x} should be 0, not -72`)
  assert.ok(Math.abs(got!.y) < 0.5, `y ${got!.y} should be 0, not -72`)
})

test('POSITIVE CONTROL: a LaTeX page is unchanged — constants and the 72pt offset', () => {
  // No point size and no offset on the page, which is every LaTeX page. The
  // arithmetic must be exactly what it was before this change: scale by the US
  // Letter constants, subtract 72.
  const p = page(0, null)
  const got = canvasToPdf(CANVAS_W / 2, p.bounds.height / 2, [p])
  assert.ok(got)
  assert.ok(Math.abs(got!.x - (PDF_WIDTH / 2 - 72)) < 0.5, `x ${got!.x}`)
  assert.ok(Math.abs(got!.y - (PDF_HEIGHT / 2 - 72)) < 0.5, `y ${got!.y}`)
})

test('a round trip returns the point it started from, on both sizes and LaTeX', () => {
  // canvasToPdf and pdfToCanvas must stay inverses. If only one of them read
  // the page's size a round trip would drift, and an annotation would move a
  // little every time it was resolved.
  for (const [label, pts] of [['letter', LETTER], ['a4', A4], ['latex', null]] as const) {
    const p = page(0, pts)
    const cx = 321, cy = 456
    const pdf = canvasToPdf(cx, cy, [p])
    assert.ok(pdf, label)
    const back = pdfToCanvas(pdf!.page, pdf!.x, pdf!.y, [p])
    assert.ok(back, label)
    assert.ok(Math.abs(back!.x - cx) < 0.01, `${label} x drifted: ${back!.x} vs ${cx}`)
    assert.ok(Math.abs(back!.y - cy) < 0.01, `${label} y drifted: ${back!.y} vs ${cy}`)
  }
})

test('the right page is chosen when pages are stacked', () => {
  // Page association is part of the coordinate, not separate from it: an
  // annotation on page 2 recorded against page 1 is wrong however good its x,y.
  const p1 = page(0, A4)
  const p2 = page(p1.bounds.height + 32, A4)
  const onSecond = canvasToPdf(CANVAS_W / 2, p2.bounds.y + p2.bounds.height / 2, [p1, p2])
  assert.ok(onSecond)
  assert.equal(onSecond!.page, 2)
  assert.ok(Math.abs(onSecond!.y - A4.h / 2) < 0.5, `y ${onSecond!.y} should be page-local`)
})
