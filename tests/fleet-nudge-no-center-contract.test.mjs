import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/shapes/fleet-utils.ts', import.meta.url), 'utf8')

test('translate matcher offers only left/right and top/bottom alignment', () => {
  const matcher = source.slice(source.indexOf('function closestFleetPanelNudge'), source.indexOf('/** The guide is the taken match'))
  assert.match(matcher, /candidate\.left, 'left'/)
  assert.match(matcher, /candidate\.right, 'right'/)
  assert.match(matcher, /candidate\.top, 'top'/)
  assert.match(matcher, /candidate\.bottom, 'bottom'/)
  assert.doesNotMatch(matcher, /centerX|centerY/)
  assert.match(matcher, /horizontalGaps/)
  assert.match(matcher, /verticalGaps/)
})

test('resize exposes only the grabbed edges and never doubles a center pull', () => {
  const resizeFeatures = source.slice(source.indexOf('function liveFleetResizeFeatures'), source.indexOf('/**\n * Turn a match'))
  const pullAxis = source.slice(source.indexOf('function pullResizedAxis'), source.indexOf('/**\n * The resize twin'))
  assert.doesNotMatch(resizeFeatures, /centerX|centerY/)
  assert.match(resizeFeatures, /handle\.includes\('left'\)/)
  assert.match(resizeFeatures, /handle\.includes\('right'\)/)
  assert.match(resizeFeatures, /handle\.includes\('top'\)/)
  assert.match(resizeFeatures, /handle\.includes\('bottom'\)/)
  assert.match(pullAxis, /const edgeDelta = match\.delta/)
  assert.doesNotMatch(pullAxis, /\* 2|centerX|centerY/)
})
