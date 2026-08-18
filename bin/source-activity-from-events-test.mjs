#!/usr/bin/env node
// The pill's "who is editing / who last changed it" derived from events alone.
//
// Display only, deliberately approximate. Skip: "our statuses including thinking
// are garbage — display only", "not to be trusted", and on tracking turn ends
// for this: "who gives a fuck about turns". So: recent activity on the file
// means editing. These assert the drawing rule, not a fact about agents.
import assert from 'node:assert/strict'
// Run under tsx -- `node --import tsx bin/source-activity-from-events-test.mjs`,
// the same loader the daemon and the rest of this repo use. An earlier draft
// hand-rolled a TypeScript-stripping module hook, which worked and was exactly
// the kind of bespoke machinery tonight has been spent deleting.
const { sourceActivityFromEvents } = await import('../src/pills/source-activity-from-events.ts')

let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (e) {
    failures++
    console.error(`  FAIL ${label}: ${e.message}`)
  }
}

const t = (n) => new Date(1786900000000 + n * 1000).toISOString()
const edit = (agent, n, project = 'paper', file = 'main.tex') => ({
  type: 'activity', from: agent, timestamp: t(n), metadata: { project, sourceFile: file },
})
const NOW = Date.parse(t(0))

check('someone who just touched the file is editing it', () => {
  const v = sourceActivityFromEvents([edit('a', -5)], 'paper', 'main.tex', undefined, NOW)
  assert.deepEqual(v.editors.map(e => e.id), ['a'])
  assert.equal(v.lastChangedBy, 'a')
  assert.equal(v.lastChangedAt, Date.parse(t(-5)))
})

check('someone who touched it an hour ago is NOT editing, but is still who changed it', () => {
  const v = sourceActivityFromEvents([edit('a', -3600)], 'paper', 'main.tex', undefined, NOW)
  assert.deepEqual(v.editors, [])
  assert.equal(v.lastChangedBy, 'a')
})

check('the most recent editor wins for last-changed', () => {
  const v = sourceActivityFromEvents([edit('a', -50), edit('b', -10)], 'paper', 'main.tex', undefined, NOW)
  assert.equal(v.lastChangedBy, 'b')
  assert.deepEqual(v.editors.map(e => e.id).sort(), ['a', 'b'])
})

check('a sibling file on the same doc room is ignored', () => {
  const v = sourceActivityFromEvents([edit('a', -5, 'paper', 'other.tex')], 'paper', 'main.tex', undefined, NOW)
  assert.deepEqual(v.editors, [])
  assert.equal(v.lastChangedAt, null)
})

check('another project is ignored', () => {
  const v = sourceActivityFromEvents([edit('a', -5, 'elsewhere', 'main.tex')], 'paper', 'main.tex', undefined, NOW)
  assert.deepEqual(v.editors, [])
})

check('order does not matter', () => {
  const f = sourceActivityFromEvents([edit('a', -50), edit('a', -5)], 'paper', 'main.tex', undefined, NOW)
  const b = sourceActivityFromEvents([edit('a', -5), edit('a', -50)], 'paper', 'main.tex', undefined, NOW)
  assert.deepEqual(f, b)
})

check('names are resolved for display', () => {
  const v = sourceActivityFromEvents([edit('fleet:abc', -5)], 'paper', 'main.tex',
    (id) => (id === 'fleet:abc' ? 'agent-puvb' : id), NOW)
  assert.deepEqual(v.editors, [{ id: 'fleet:abc', name: 'agent-puvb' }])
  assert.equal(v.lastChangedBy, 'agent-puvb')
})

check('no events is empty, not an error', () => {
  const v = sourceActivityFromEvents([], 'paper', 'main.tex', undefined, NOW)
  assert.deepEqual(v, { editors: [], lastChangedAt: null, lastChangedBy: null })
})

console.log(failures === 0 ? 'PASS source activity from events' : `FAIL source activity from events (${failures})`)
process.exit(failures === 0 ? 0 : 1)
