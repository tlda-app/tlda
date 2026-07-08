// Guards the unified-server wiring of the wake circuit breaker (the pure gate +
// backoff math are behaviorally tested in task-renudge.test.mjs; the drain/sweep
// wiring lives in unified-server.mjs, which boots the whole server — so this
// source-assertion pins the invariants against regression. The real end-to-end
// proof is the post-deploy live-log check (breaker opens, wakes stop).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = () => readFileSync(path.join(ROOT, 'server', 'unified-server.mjs'), 'utf8')

test('breaker state exists and is wired into the sweep decision', () => {
  const src = server()
  assert.match(src, /const _wakeBreaker = new Map\(\)/)
  assert.match(src, /wakeBreaker: _wakeBreaker/, 'sweep passes the breaker to decideTaskRenudges')
})

test('a terminal wake failure records into the breaker with capped exponential backoff', () => {
  const src = server()
  assert.match(src, /b\.fails \+= 1/)
  assert.match(src, /b\.nextTs = Date\.now\(\) \+ wakeBreakerBackoffMs\(b\.fails, WAKE_BREAKER_BASE_MS, WAKE_BREAKER_CAP_MS\)/)
  assert.match(src, /_wakeBreaker\.set\(agentId, b\)/)
})

test('breaker resets on recovery (markAgentAlive) and on a successful wake', () => {
  const src = server()
  // §4.2: cleared on the not-alive→alive transition
  assert.match(src, /if \(!wasAlive\) \{[\s\S]*_wakeBreaker\.delete\(agentId\)/)
  // §4.1: cleared by onTaskWakeSuccess
  assert.match(src, /function onTaskWakeSuccess\(agentId, keys = \[\]\) \{\s*_wakeBreaker\.delete\(agentId\)/)
})

test('renudge throttle stamp moved off the pre-attempt sweep onto successful wake (§5)', () => {
  const src = server()
  // the old pre-attempt stamp (keyed by nudge.key in the sweep loop) is gone
  assert.equal(src.includes('_taskRenudged.set(nudge.key'), false, 'pre-attempt stamp must be removed')
  // the stamp now lives on the success path, keyed by the threaded task keys
  assert.match(src, /for \(const key of keys\) _taskRenudged\.set\(key, \{ ts: now \}\)/)
})
