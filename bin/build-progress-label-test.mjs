import assert from 'node:assert/strict'

import { buildProgressLabel } from '../src/pills/build-progress-label.mjs'

const activityLabel = 'b4-live-writer is editing'

assert.equal(buildProgressLabel({ visible: false, phase: null, detail: null, activityLabel }), activityLabel)
assert.equal(
  buildProgressLabel({ visible: true, phase: 'compiling', detail: 'page 2', activityLabel }),
  'compiling page 2',
  'visible build status takes precedence over source editing activity',
)

console.log('build-progress-label-test: ok')
