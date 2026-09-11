import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/shapes/FleetPillShape.tsx', import.meta.url), 'utf8')
const drop = source.slice(source.indexOf('export async function dropPillOnTarget'))

test('live filter preview commits before canvas hit-testing', () => {
  const previewCommit = drop.indexOf('if (!content && filterDropPreview.shapeId)')
  const canvasHitTest = drop.indexOf('const allChats =')

  assert.ok(previewCommit >= 0, 'missing live filter preview commit path')
  assert.ok(canvasHitTest >= 0, 'missing canvas hit-test path')
  assert.ok(
    previewCommit < canvasHitTest,
    'standalone index chat must commit its live preview before entering WM canvas hit-testing',
  )
})
