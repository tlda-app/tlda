// The pill used to poll /:name/source-activity every 1000ms per open source
// file. It now reads that route once on mount and is told about changes. That
// only works if the changes are actually announced, so this covers the edges
// that used to be found by asking again a second later.
import { test } from 'node:test'
import assert from 'node:assert'
import {
  __test,
  activeSourceEditors,
  onSourceEditActivityChange,
  recordSourceEditActivity,
  recordSourceEditTurnEnded,
} from './source-edit-activity.mjs'
import { sourceActivityPayload } from './source-activity-payload.mjs'

const edit = (over = {}) => ({
  tool: 'Edit',
  agent_id: 'fleet:writer',
  project: 'bregman',
  sourceFile: 'b4-outline.md',
  correlationId: 'c1',
  ...over,
})

function collect() {
  const seen = []
  const stop = onSourceEditActivityChange((change) => seen.push(change))
  return { seen, stop }
}

test('starting an edit announces the file once, not once per message', () => {
  __test.reset()
  const { seen, stop } = collect()

  recordSourceEditActivity(edit())
  assert.deepEqual(seen, [{ project: 'bregman', file: 'b4-outline.md' }],
    'the first edit message announces')

  recordSourceEditActivity(edit())
  recordSourceEditActivity(edit({ status: 'completed' }))
  assert.equal(seen.length, 1,
    'an edit already announced does not re-announce; the editor set has not changed')

  stop()
})

test('a turn ending announces every file that agent held', () => {
  __test.reset()
  recordSourceEditActivity(edit())
  recordSourceEditActivity(edit({ sourceFile: 'b4-intro.md', correlationId: 'c2' }))
  const { seen, stop } = collect()

  recordSourceEditTurnEnded('fleet:writer')

  assert.deepEqual(seen.map(s => s.file).sort(), ['b4-intro.md', 'b4-outline.md'],
    'both files are announced, because both stopped having an editor')
  assert.deepEqual(activeSourceEditors('bregman', 'b4-outline.md'), [])
  stop()
})

test('a failed edit announces, so nobody is left shown as editing', () => {
  __test.reset()
  recordSourceEditActivity(edit())
  const { seen, stop } = collect()

  recordSourceEditActivity(edit({ status: 'error' }))

  assert.deepEqual(seen, [{ project: 'bregman', file: 'b4-outline.md' }])
  assert.deepEqual(activeSourceEditors('bregman', 'b4-outline.md'), [])
  stop()
})

test('an announce listener that throws does not stop the others', () => {
  __test.reset()
  const seen = []
  const stopBad = onSourceEditActivityChange(() => { throw new Error('listener is broken') })
  const stopGood = onSourceEditActivityChange((change) => seen.push(change))

  recordSourceEditActivity(edit())

  assert.equal(seen.length, 1, 'the working listener still hears it')
  stopBad()
  stopGood()
})

test('unsubscribing stops delivery', () => {
  __test.reset()
  const { seen, stop } = collect()
  stop()

  recordSourceEditActivity(edit())

  assert.deepEqual(seen, [])
})

test('the pushed payload carries the same fields the route answers with', async () => {
  __test.reset()
  recordSourceEditActivity(edit())
  const fleetStore = {
    getAgent: async (id) => (id === 'fleet:writer' ? { friendly_name: 'writer' } : null),
    lastSourceFileChange: async () => ({ agentId: 'fleet:writer', timestamp: '2026-08-17T12:00:00.000Z' }),
  }

  const payload = await sourceActivityPayload(fleetStore, 'bregman', 'b4-outline.md')

  // These four are what BuildProgressPill renders. A push that dropped one
  // would show as the pill going blank rather than as an error.
  assert.deepEqual(Object.keys(payload).sort(), ['editors', 'file', 'lastChangedAt', 'lastChangedBy'])
  assert.deepEqual(payload.editors, [{ id: 'fleet:writer', name: 'writer' }])
  assert.equal(payload.file, 'b4-outline.md')
  assert.equal(payload.lastChangedBy, 'writer')
  assert.equal(payload.lastChangedAt, Date.parse('2026-08-17T12:00:00.000Z'))
})

test('a file with no editor and no history answers, rather than throwing', async () => {
  __test.reset()
  const payload = await sourceActivityPayload({}, 'bregman', 'untouched.md')
  assert.deepEqual(payload, { file: 'untouched.md', editors: [], lastChangedAt: null, lastChangedBy: null })
})
