import test from 'node:test'
import assert from 'node:assert/strict'
import { decideFollowTransition } from '../src/shapes/chatScrollIntent.mjs'

test('downward anchor reconciliation cannot resume following', () => {
  const transition = decideFollowTransition(
    { top: 900, height: 1200, clientHeight: 300, lastTop: 700, lastHeight: 1200 },
    { scrolledUp: true, hardLocked: false, geometryReconciliation: true, userInputActive: false },
  )

  assert.deepEqual(transition, { scrolledUp: true, action: 'none' })
})

test('reader movement to the bottom resumes following', () => {
  const transition = decideFollowTransition(
    { top: 900, height: 1200, clientHeight: 300, lastTop: 700, lastHeight: 1200 },
    { scrolledUp: true, hardLocked: false, geometryReconciliation: false, userInputActive: true },
  )

  assert.deepEqual(transition, { scrolledUp: false, action: 'follow-on' })
})

test('content growth shifting the viewport upward does not disable follow', () => {
  const transition = decideFollowTransition(
    {
      top: 13900.9091796875,
      height: 14290,
      clientHeight: 321,
      lastTop: 13929.544921875,
      lastHeight: 14222,
    },
    { scrolledUp: false, hardLocked: false, geometryReconciliation: false, userInputActive: false },
  )

  assert.deepEqual(transition, { scrolledUp: false, action: 'none' })
})
