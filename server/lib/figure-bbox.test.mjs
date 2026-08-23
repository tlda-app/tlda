import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'

import { pngBoundingBox, jpegBoundingBox, pdfBoundingBox, figureBoundingBox } from './build-runner.mjs'

// A wrong bounding box is the silent-and-destructive case this file exists for:
// the build SUCCEEDS and every figure is laid out at the wrong size, so nothing
// reports it except a person looking at the page. The readers are pure, so the
// fixtures are synthesised here rather than checked in as binaries.

const crcTable = [...Array(256)].map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = b => {
  let c = 0xffffffff
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function makePng(w, h, { dpi = null, physUnit = 1 } = {}) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr)]
  if (dpi) {
    const ppm = Math.round(dpi / 0.0254)
    const phys = Buffer.alloc(9)
    phys.writeUInt32BE(ppm, 0); phys.writeUInt32BE(ppm, 4); phys[8] = physUnit
    parts.push(pngChunk('pHYs', phys))
  }
  parts.push(pngChunk('IDAT', deflateSync(Buffer.alloc(h * (1 + w * 3)))), pngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

// Only the marker structure is walked, so a real entropy-coded scan is not needed.
function makeJpeg(w, h, { density = null, densityUnits = 1, sofMarker = 0xc0 } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])]
  if (density) {
    const app0 = Buffer.alloc(16)
    app0.writeUInt16BE(0xffe0, 0); app0.writeUInt16BE(14, 2)
    app0.write('JFIF\0', 4, 'latin1')
    app0[9] = 1; app0[10] = 2
    app0[11] = densityUnits
    app0.writeUInt16BE(density, 12); app0.writeUInt16BE(density, 14)
    parts.push(app0)
  }
  const sof = Buffer.alloc(11)
  sof.writeUInt16BE(0xff00 | sofMarker, 0); sof.writeUInt16BE(9, 2)
  sof[4] = 8
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7)
  sof[9] = 1
  parts.push(sof, Buffer.from([0xff, 0xda]))
  return Buffer.concat(parts)
}

const makePdf = (x0, y0, x1, y1) =>
  Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Page/MediaBox[${x0} ${y0} ${x1} ${y1}]>>endobj\n%%EOF`, 'latin1')

test('a PNG with no pHYs is one pixel per bp', () => {
  assert.deepEqual(pngBoundingBox(makePng(300, 200)), { w: 300, h: 200 })
})

test('a PNG with pHYs is scaled by its own resolution', () => {
  // 600px at 150dpi is 4 inches is 288bp.
  //
  // Compared with a tolerance rather than exactly, and the reason is a property
  // of the format rather than of this code: pHYs stores INTEGER pixels-per-metre,
  // so 150dpi is written as round(150/0.0254) = 5906 ppm and reads back as
  // 150.0124dpi. The exact value is not representable and 287.976 is the correct
  // answer, not a rounding bug to fix. A tenth of a bp is far below anything
  // visible, and \includegraphics[width=...] overrides it in most documents.
  const box = pngBoundingBox(makePng(600, 400, { dpi: 150 }))
  assert.ok(Math.abs(box.w - 288) < 0.1, `width ${box.w} should be ~288`)
  assert.ok(Math.abs(box.h - 192) < 0.1, `height ${box.h} should be ~192`)
})

test('pHYs with unit 0 is an aspect ratio, not a resolution, so 72dpi stands', () => {
  // unit 0 means the numbers are a ratio with no physical meaning. Treating
  // them as pixels-per-metre would make the figure absurdly small.
  assert.deepEqual(pngBoundingBox(makePng(300, 200, { dpi: 150, physUnit: 0 })), { w: 300, h: 200 })
})

test('a JPEG frame is found by walking to its SOF marker', () => {
  assert.deepEqual(jpegBoundingBox(makeJpeg(400, 250)), { w: 400, h: 250 })
})

test('a JPEG honours JFIF density in dpi and in dots-per-cm', () => {
  assert.deepEqual(jpegBoundingBox(makeJpeg(600, 300, { density: 150 })), { w: 288, h: 144 })
  // units 2 is dots per cm: 100/cm is 254dpi.
  const perCm = jpegBoundingBox(makeJpeg(254, 254, { density: 100, densityUnits: 2 }))
  assert.equal(Math.round(perCm.w), 72)
})

test('a progressive JPEG (SOF2) is measured like a baseline one', () => {
  assert.deepEqual(jpegBoundingBox(makeJpeg(320, 240, { sofMarker: 0xc2 })), { w: 320, h: 240 })
})

test('a DHT segment is not mistaken for a frame', () => {
  // 0xc4 sits inside the SOF marker range and is not a frame. Reading it as one
  // would produce a bounding box from Huffman table bytes.
  assert.equal(jpegBoundingBox(makeJpeg(100, 100, { sofMarker: 0xc4 })), null)
})

test('a PDF is measured from its MediaBox, including a non-zero origin', () => {
  assert.deepEqual(pdfBoundingBox(makePdf(0, 0, 216, 144)), { w: 216, h: 144 })
  assert.deepEqual(pdfBoundingBox(makePdf(10, 20, 110, 220)), { w: 100, h: 200 })
})

test('figureBoundingBox dispatches on extension, case-insensitively', () => {
  const png = makePng(50, 60)
  assert.deepEqual(figureBoundingBox('/f/a.PNG', png), { w: 50, h: 60 })
  assert.deepEqual(figureBoundingBox('/f/a.jpeg', makeJpeg(10, 20)), { w: 10, h: 20 })
  assert.equal(figureBoundingBox('/f/a.tiff', png), null)
})

// The negative cases matter as much as the positive ones: a reader that returns
// a plausible number for a file it cannot actually parse writes a .bb that sizes
// every figure wrongly, and the build still succeeds.
test('unreadable input yields no box rather than a wrong one', () => {
  assert.equal(pngBoundingBox(Buffer.alloc(0)), null)
  assert.equal(pngBoundingBox(makePng(10, 10).subarray(0, 20)), null, 'truncated before IHDR dimensions')
  assert.equal(pngBoundingBox(makeJpeg(10, 10)), null, 'JPEG is not a PNG')
  assert.equal(jpegBoundingBox(makePng(10, 10)), null, 'PNG is not a JPEG')
  assert.equal(pdfBoundingBox(Buffer.from('not a pdf')), null)
  assert.equal(pdfBoundingBox(Buffer.from('%PDF-1.4 no mediabox here')), null)
  assert.equal(pngBoundingBox(makePng(0, 10)), null, 'a zero dimension is not a size')
})

// ─── The stem collision is announced, because it is otherwise silent ─────────
//
// `foo.png` and `foo.pdf` in one directory both map to `foo.bb`, so one of them
// silently sizes the other. The build still succeeds; the only symptom is a
// figure at the wrong size. These assert the build log names the winner.

import { mkdtempSync, writeFileSync as write, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateRasterBoundingBoxes } from './build-runner.mjs'

function withFixture(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-bbtest-'))
  try {
    for (const [name, buf] of Object.entries(files)) write(join(dir, name), buf)
    const logs = []
    generateRasterBoundingBoxes(dir, m => logs.push(m))
    return fn(logs, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('two figures sharing a stem are named in the build log', () => {
  withFixture({ 'fig.png': makePng(300, 200), 'fig.pdf': makePdf(0, 0, 216, 144) }, logs => {
    const collision = logs.find(l => l.includes('share the stem'))
    assert.ok(collision, `expected a collision log, got: ${JSON.stringify(logs)}`)
    assert.match(collision, /"fig"/)
    assert.match(collision, /fig\.(png|pdf) overwrites/)
  })
})

test('distinct stems produce no collision log', () => {
  // The control: this warning must not fire on an ordinary figure directory,
  // or it becomes noise and stops being read.
  withFixture({ 'a.png': makePng(10, 10), 'b.pdf': makePdf(0, 0, 20, 20) }, logs => {
    assert.equal(logs.find(l => l.includes('share the stem')), undefined)
    assert.ok(logs.some(l => l.includes('Generated 2 .bb')), JSON.stringify(logs))
  })
})

test('a stub PDF beside its SVG is skipped, so it is not a collision', () => {
  // The SVG path writes fig.pdf and fig.bb from fig.svg. Treating that pair as
  // a collision would warn on every SVG figure in the project.
  withFixture({
    'fig.svg': Buffer.from('<svg viewBox="0 0 100 50"></svg>'),
    'fig.pdf': makePdf(0, 0, 100, 50),
    'fig.png': makePng(80, 40),
  }, logs => {
    assert.equal(logs.find(l => l.includes('share the stem')), undefined, JSON.stringify(logs))
  })
})
