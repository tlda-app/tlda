import test from 'node:test'
import assert from 'node:assert/strict'

import { isPlanModeResponse, planModeResponseKey } from '../server/lib/plan-mode-response.mjs'

test('plan-mode responses match Claude Code numbered menu options', () => {
  assert.equal(planModeResponseKey('approve'), '1')
  assert.equal(planModeResponseKey('supervised'), '2')
  assert.equal(planModeResponseKey('reject'), '3')
})

test('plan-mode response validation rejects unknown responses', () => {
  assert.equal(isPlanModeResponse('approve'), true)
  assert.equal(isPlanModeResponse('supervised'), true)
  assert.equal(isPlanModeResponse('reject'), true)
  assert.equal(isPlanModeResponse('yes'), false)
  assert.equal(isPlanModeResponse(''), false)
  assert.equal(isPlanModeResponse(null), false)
})
