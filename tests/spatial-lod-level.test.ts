import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

// spatialDocumentWorld.ts drags the app graph (window, tldraw runtime) at
// import time, so the suite executes the SHIPPED predicate extracted from the
// source rather than importing the module — the same pattern as the
// pattern-lod-cap test. If the extraction fails, the predicate moved and the
// test says so instead of silently passing.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'src/spatialDocumentWorld.ts'), 'utf8')

function extractConst(src: string, name: string): string {
  const match = src.match(new RegExp(`export const ${name} = ([^\\n;]+);?`))
  assert.ok(match, `shipped ${name} found`)
  return `const ${name} = ${match[1]};`
}

function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`export function ${name}(`)
  assert.ok(start >= 0, `shipped ${name} found`)
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  // Strip erasable TS (return-type annotation) so plain node can run it.
  return src.slice(start, i + 1)
    .replace('export function', 'function')
    .replace(/\)(\s*): \w+ \{/, ')$1{')
    .replace(/(\w+): number\)/, '$1)')
}

const sandbox: Record<string, unknown> = {}
vm.createContext(sandbox)
vm.runInContext([
  extractConst(SRC, 'SPATIAL_MAP_ZOOM'),
  extractConst(SRC, 'SPATIAL_MID_ZOOM'),
  extractFunction(SRC, 'spatialLodLevelForZoom'),
].join('\n'), sandbox)
const lod = vm.runInContext('spatialLodLevelForZoom', sandbox) as (z: number) => string
const MAP_ZOOM = vm.runInContext('SPATIAL_MAP_ZOOM', sandbox) as number
const MID_ZOOM = vm.runInContext('SPATIAL_MID_ZOOM', sandbox) as number

test('mid band sits strictly between map and full', () => {
  assert.ok(MAP_ZOOM < MID_ZOOM)
  assert.equal(lod(MAP_ZOOM), 'map')
  assert.equal(lod(MID_ZOOM), 'mid')
})

test('lod level follows zoom across all three bands', () => {
  assert.equal(lod(0.001), 'map')
  assert.equal(lod(MAP_ZOOM), 'map')
  assert.equal(lod(MAP_ZOOM + 0.001), 'mid')
  assert.equal(lod(MID_ZOOM), 'mid')
  assert.equal(lod(MID_ZOOM + 0.001), 'full')
  assert.equal(lod(1), 'full')
  assert.equal(lod(8), 'full')
})
