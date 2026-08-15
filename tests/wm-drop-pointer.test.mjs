import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentWMDropPointer, recordWMDropPointer } from '../src/wm/drop-targets.ts'

test('WM drops retain the pointer in browser client coordinates', () => {
  const point = { x: 712, y: 438 }
  recordWMDropPointer(point)
  point.x = -16000

  assert.deepEqual(currentWMDropPointer(), { x: 712, y: 438 })
})
