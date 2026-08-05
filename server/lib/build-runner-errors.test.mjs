import assert from 'node:assert/strict'
import test from 'node:test'
import { assertLatexBuildHasNoErrors } from './build-runner.mjs'

test('a TeX error prevents publication of the candidate render', () => {
  assert.throws(
    () => assertLatexBuildHasNoErrors([{ message: 'Undefined control sequence' }]),
    /keeping the last successful render/,
  )
})

test('warnings do not prevent publication when TeX produced no errors', () => {
  assert.doesNotThrow(() => assertLatexBuildHasNoErrors([]))
})
