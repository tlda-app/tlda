import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('terminal composer completes the voice epoch after Enter sends', () => {
  const source = fs.readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
  const handlerStart = source.indexOf('const handleInputKeyDown =')
  const handlerEnd = source.indexOf('\n  const handleResizePointerDown', handlerStart)
  const handler = source.slice(handlerStart, handlerEnd)

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart)
  assert.match(handler, /const text = inputRef\.current\?\.value \?\? ''/)
  assert.match(handler, /submitInput\(text\)[\s\S]*inputRef\.current\.value = ''[\s\S]*completeMessageSend\(text\)/)
})
