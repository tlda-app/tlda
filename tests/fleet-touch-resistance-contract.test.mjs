import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { applyAxisResistance } from '../packages/tldraw-wm/src/gesture-policy.ts'

test('axis resistance is continuous and returns to one-to-one motion after release', () => {
  assert.deepEqual(applyAxisResistance(12, 24), { delta: 0, stuck: true })
  assert.deepEqual(applyAxisResistance(24, 24), { delta: 0, stuck: true })
  assert.deepEqual(applyAxisResistance(25, 24), { delta: 1, stuck: false })
  assert.deepEqual(applyAxisResistance(40, 24), { delta: 16, stuck: false })
  assert.deepEqual(applyAxisResistance(-25, 24), { delta: -1, stuck: false })
})

test('fleet touch resize uses the shared nudge and guide path without the axis lock', () => {
  const source = readFileSync(new URL('../src/overlays/useFleetGestures.ts', import.meta.url), 'utf8')
  assert.match(source, /nudgeFleetPanelResize/)
  assert.match(source, /nudgeFleetPanelTranslate/)
  assert.match(source, /additionalGuides: selfGuides/)
  assert.doesNotMatch(source, /applyShapeResizeAxisLock/)
  assert.match(source, /animateShape\(update, \{ animation: \{ duration: 80 \} \}\)/)
})
