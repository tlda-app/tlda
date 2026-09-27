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

test('an MD file card drag carries the identity the drop resolves', () => {
  // The drop resolves the file through the click-path chain (uploaded URL,
  // else the sender's file via resolve-chat-file), so the drag must carry
  // the same identity a click reads from the card and its chat line.
  const mdCardDrag = chatShape.slice(
    chatShape.indexOf('// MD file card'),
    chatShape.indexOf('const tldaCard'),
  )
  assert.ok(mdCardDrag.length > 0, 'the MD file card drag branch must exist')
  assert.match(
    mdCardDrag,
    /mdCard\.dataset\.url/,
    'the drag must carry the card URL for the uploaded-file case',
  )
  assert.match(
    mdCardDrag,
    /closest\('\[data-msg-from\]'\)/,
    'the drag must carry the sender for the resolve-chat-file case',
  )
  assert.match(
    mdCardDrag,
    /sourceAgent/,
    'the drag payload must forward the sender to the pill meta',
  )
})
