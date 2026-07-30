import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { overlapsRibbonX } from '../src/ribbonZone'

test('highlight far left of the ribbon is not captured as a ribbon mark', () => {
  assert.equal(overlapsRibbonX({ minX: -80, maxX: -20 }, { minX: 0, maxX: 6 }), false)
})

test('highlight overlapping the ribbon is captured as a ribbon mark', () => {
  assert.equal(overlapsRibbonX({ minX: -2, maxX: 4 }, { minX: 0, maxX: 6 }), true)
})

after(() => {
  setImmediate(() => process.exit(process.exitCode || 0))
})
