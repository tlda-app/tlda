#!/usr/bin/env node
import assert from 'node:assert/strict'
import { resumeId } from '../agent-launch/harness/codex.mjs'

assert.equal(
  resumeId({ rolloutId: 'rollout-2026-07-24T14-06-48-019f954e-f753-73f0-ba96-d637f89ff8da' }),
  '019f954e-f753-73f0-ba96-d637f89ff8da',
)
assert.equal(
  resumeId({ rolloutId: '019f954e-f753-73f0-ba96-d637f89ff8da' }),
  '019f954e-f753-73f0-ba96-d637f89ff8da',
)
assert.equal(resumeId({ rolloutId: null }), null)

console.log('codex resume id regression: ok')
