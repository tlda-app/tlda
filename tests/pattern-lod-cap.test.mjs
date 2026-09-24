import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

// The spatial map stretches every document editor's zoom ladder floor to
// 0.001 (SPATIAL_MAP_ZOOM_STEPS in src/spatialDocumentWorld.ts). Tldraw's
// pattern hook derives maxEffectiveZoom = zoomSteps[last]/zoomSteps[0] =
// 8000 and prefetches a LOD level per power of two, two themes each. At 14
// levels that meant 28 pattern blobs on every editor mount, including
// 16384x16384 canvases (~1GB each) plus PNG encodes, all on the main
// thread — 71s of generateImage on book load, freezing every tab.
//
// The patch in patches/tldraw+5.2.0.patch caps the prefetched LOD levels.
// These tests guard the capped files the app actually ships: if the patch
// stops applying or the cap is raised past a sane mount budget, they fail.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST_FILES = [
  'node_modules/tldraw/dist-esm/lib/shapes/shared/defaultStyleDefs.mjs',
  'node_modules/tldraw/dist-cjs/lib/shapes/shared/defaultStyleDefs.js',
]
// Worst-case mount budget for pattern blobs: levels x themes x max canvas.
// Uncapped (14 levels, 16384px canvases) this is ~8GB; capped it is KBs.
const MOUNT_BLOB_BUDGET_BYTES = 50 * 1024 * 1024
const TILE_PATTERN_SIZE = 8
const THEMES = 2
const DPR = 2

function readDist(rel) {
  const full = path.join(ROOT, rel)
  assert.ok(fs.existsSync(full), `expected shipped file to exist: ${rel}`)
  return fs.readFileSync(full, 'utf8')
}

for (const rel of DIST_FILES) {
  test(`pattern LOD prefetch is capped in ${rel}`, () => {
    const src = readDist(rel)
    const cap = src.match(/const MAX_PATTERN_LOD = (\d+);/)
    assert.ok(cap, 'MAX_PATTERN_LOD constant present')
    assert.ok(
      src.includes('Math.min(getPatternLodForZoomLevel(maxZoom), MAX_PATTERN_LOD)'),
      'getPatternLodsToGenerate applies the MAX_PATTERN_LOD cap',
    )
    const levels = Number(cap[1]) + 1
    const maxZoom = 2 ** Number(cap[1])
    const maxCanvasPx = TILE_PATTERN_SIZE * maxZoom * DPR
    const bytes = levels * THEMES * maxCanvasPx * maxCanvasPx * 4
    assert.ok(
      bytes < MOUNT_BLOB_BUDGET_BYTES,
      `capped prefetch fits the mount budget: ${levels} levels x ${THEMES} themes x ${maxCanvasPx}px = ${(bytes / 1024).toFixed(0)}KB`,
    )
  })
}

// Extract a top-level `function name(...) {...}` with balanced braces.
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `shipped ${name} found`)
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  assert.fail(`unterminated ${name}`)
}

// Execute the SHIPPED LOD logic (extracted from the dist file, not
// reimplemented) at the book's maxEffectiveZoom = 8/0.001.
function shippedLodsFor(src, maxZoom) {
  const constMatch = src.match(/const MAX_PATTERN_LOD = (\d+);/)
  const prelude = constMatch ? constMatch[0] : ''
  const sandbox = {}
  vm.createContext(sandbox)
  const script = [
    prelude,
    extractFunction(src, 'getPatternLodForZoomLevel'),
    extractFunction(src, 'getPatternLodsToGenerate'),
    'getPatternLodsToGenerate(MAX_ZOOM)',
  ].join('\n')
  sandbox.MAX_ZOOM = maxZoom
  return vm.runInContext(script, sandbox)
}

for (const rel of DIST_FILES) {
  test(`shipped LOD logic yields 5 small levels at book zoom in ${rel}`, () => {
    const levels = [...shippedLodsFor(readDist(rel), 8 / 0.001)]
    assert.deepEqual(levels, [1, 2, 4, 8, 16])
    const maxCanvasPx = TILE_PATTERN_SIZE * levels[levels.length - 1] * DPR
    assert.ok(maxCanvasPx <= 1024, `largest prefetched canvas is ${maxCanvasPx}px, not 16384px`)
  })
}

test('uncapped ladder would still explode without the fix', () => {
  // Documents why the cap exists: with the 0.001 spatial-map floor,
  // maxEffectiveZoom = 8/0.001 = 8000 -> lod ceil(log2(8000)) = 13, i.e.
  // 14 levels of which the top ones rasterize at the 16384px image cap.
  const lodForZoom = (zoom) => Math.ceil(Math.log2(Math.max(1, zoom)))
  assert.equal(lodForZoom(8 / 0.001), 13)
})
