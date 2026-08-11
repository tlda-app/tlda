import assert from 'node:assert/strict'
import test from 'node:test'

import { registeredDropTargetFromElements } from '../src/wm/drop-target-resolution.mjs'

test('drop target resolution follows visual hit order, not registration order', () => {
  const behind = { parentElement: null }
  const front = { parentElement: null }
  const frontChild = { parentElement: front }
  const targets = new Map()
  targets.set(front, { accepts: () => true, name: 'front' })
  targets.set(behind, { accepts: () => true, name: 'behind' })

  const resolved = registeredDropTargetFromElements(
    [frontChild, behind],
    element => targets.get(element),
    { kind: 'fleet-pill', data: {} },
  )

  assert.equal(resolved?.element, front)
  assert.equal(resolved?.target.name, 'front')
})
