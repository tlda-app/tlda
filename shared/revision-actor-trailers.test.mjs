import test from 'node:test'
import assert from 'node:assert/strict'
import { formatActorTrailers, parseActorTrailers } from './revision-actor-trailers.mjs'

test('actor trailers round-trip through a commit message', () => {
  const body = formatActorTrailers({ actor: 'fleet:c21eb760', daemon: 'mini:testing' })
  const parsed = parseActorTrailers(`tlda settled edit cluster\n\n${body}\n`)
  assert.deepEqual(parsed, { actor: 'fleet:c21eb760', daemon: 'mini:testing', unknown: null })
})

test('unknown trailers round-trip with their reason', () => {
  const body = formatActorTrailers({ daemon: 'source-room:paper', unknown: 'browser-actor-unwired' })
  const parsed = parseActorTrailers(`tlda settled edit cluster\n\n${body}\n`)
  assert.deepEqual(parsed, { actor: null, daemon: 'source-room:paper', unknown: 'browser-actor-unwired' })
})

test('a message without trailers parses to all nulls', () => {
  assert.deepEqual(parseActorTrailers('tlda project revision\n'), { actor: null, daemon: null, unknown: null })
  assert.deepEqual(parseActorTrailers(null), { actor: null, daemon: null, unknown: null })
  assert.deepEqual(parseActorTrailers(''), { actor: null, daemon: null, unknown: null })
})

test('format requires exactly one of actor and unknown', () => {
  assert.throws(() => formatActorTrailers({ daemon: 'mini:testing' }), /exactly one of actor and unknown/)
  assert.throws(() => formatActorTrailers({ actor: 'a', unknown: 'no-observed-edit' }), /exactly one of actor and unknown/)
})

test('trailer values cannot smuggle newlines into the commit message', () => {
  const body = formatActorTrailers({ actor: 'agent\nTlda-Actor: forged', daemon: 'mini:testing' })
  assert.ok(!body.includes('forged'))
  assert.deepEqual(parseActorTrailers(body).actor, 'agent')
})
