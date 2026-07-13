import test from 'node:test'
import assert from 'node:assert/strict'
import { boundActivityMetadata, boundActivityPayload } from '../shared/activity-payload-bounds.mjs'

test('activity metadata bounds large strings before server JSON serialization', () => {
  const huge = 'x'.repeat(100_000)
  const metadata = boundActivityMetadata({
    tool: 'exec',
    arg: huge,
    input: {
      command: huge,
      nested: { value: huge },
    },
    prettyResult: huge,
    activityLatency: { jsonlTs: '2026-07-13T02:30:00.000Z' },
  })

  assert.equal(metadata.tool, 'exec')
  assert.equal(metadata.activityLatency.jsonlTs, '2026-07-13T02:30:00.000Z')
  assert.ok(metadata.arg.length < 17_000)
  assert.ok(metadata.input.command.length < 17_000)
  assert.ok(metadata.input.nested.value.length < 17_000)
  assert.ok(metadata.prettyResult.length < 17_000)
  assert.match(metadata.prettyResult, /truncated 84000 chars/)
  assert.ok(JSON.stringify(metadata).length < 80_000)
})

test('activity payload bounds arrays, object keys, and nesting', () => {
  const bounded = boundActivityPayload({
    many: Array.from({ length: 100 }, (_, i) => `item-${i}`),
    deep: { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } },
    wide: Object.fromEntries(Array.from({ length: 140 }, (_, i) => [`k${i}`, i])),
  })

  assert.equal(bounded.many.length, 81)
  assert.equal(bounded.many.at(-1), '[truncated 20 array items]')
  assert.equal(bounded.deep.a.b.c.d.e, '[truncated nested value]')
  assert.equal(bounded.wide.__truncatedKeys, 20)
})
