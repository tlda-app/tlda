import assert from 'node:assert/strict'
import test from 'node:test'

import { completePillDrag } from '../src/shapes/fleet-pill-gesture.ts'

test('a stationary agent-pill touch selects through the supplied target route', () => {
  let selections = 0

  assert.equal(completePillDrag({ started: false }, () => { selections += 1 }), false)
  assert.equal(selections, 1)
})

test('a moved agent-pill gesture remains a drag and does not select a target', () => {
  let selections = 0

  assert.equal(completePillDrag({ started: true }, () => { selections += 1 }), true)
  assert.equal(selections, 0)
})
