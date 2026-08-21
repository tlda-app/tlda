import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const renderer = readFileSync(new URL('../src/fleet/chat-render.mjs', import.meta.url), 'utf8')
const chatShape = readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')

test('Markdown chips use the canvas pointer drag without a competing native browser drag', () => {
  assert.doesNotMatch(
    renderer,
    /ref-chip ref-chip-doc[^>`]*draggable="true"/,
    'a native drag cancels the pointer stream before FleetChatShape can create and drop its canvas pill',
  )
  assert.match(chatShape, /target\.closest\([\s\S]*\.ref-chip:not\(\.ref-chip-annotation\)/)
  assert.match(chatShape, /dropPillOnTarget\([\s\S]*drag\.content/)
})
