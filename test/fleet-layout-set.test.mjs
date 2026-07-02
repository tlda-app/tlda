import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pillSource = readFileSync(new URL('../src/pills/FleetIconPill.tsx', import.meta.url), 'utf8')
const layoutSource = readFileSync(new URL('../src/shapes/fleet-utils.ts', import.meta.url), 'utf8')

function sourceBetween(source, start, end) {
  const startIdx = source.indexOf(start)
  assert.notEqual(startIdx, -1, `missing start marker: ${start}`)
  const endIdx = source.indexOf(end, startIdx + start.length)
  assert.notEqual(endIdx, -1, `missing end marker after ${start}: ${end}`)
  return source.slice(startIdx, endIdx)
}

test('fleet layout preset ids are exposed in the requested order', () => {
  const presetBlock = sourceBetween(pillSource, 'const LAYOUT_PRESETS', ']\n')
  const ids = [...presetBlock.matchAll(/\{ id: '([^']+)'/g)].map(match => match[1])
  assert.deepEqual(ids, ['phone', '3-col', '2x2', 'big-chat', 'both-margins'])
})

test('phone preset thumbnail is a phone silhouette', () => {
  const iconBlock = sourceBetween(pillSource, "'phone': (", "    ),\n  }")
  assert.match(iconBlock, /phone silhouette/)
  assert.match(iconBlock, /stroke="currentColor"/)
  assert.match(iconBlock, /home indicator/)
})

test('layout slider selection applies the chosen preset', () => {
  const sliderRender = sourceBetween(pillSource, '<CornerButtonSlider', '/>')
  assert.match(sliderRender, /options=\{layoutSliderOptions\}/)
  assert.match(sliderRender, /onSelect=\{applyPreset\}/)
})

test('2x2 layout creates four chats and no document viewer', () => {
  const gridBranch = sourceBetween(layoutSource, "} else if (variant === '2x2')", "} else if (variant === '3-col')")
  const chatCount = (gridBranch.match(/type: 'fleet-chat'/g) || []).length
  assert.equal(chatCount, 4)
  assert.equal(gridBranch.includes("type: 'fleet-docview'"), false)
})

test('big-chat and both-margins create their expected reading/writing panels', () => {
  const bigChatBranch = sourceBetween(layoutSource, "variant === 'big-chat'", "} else if (variant === '2x2')")
  const bothMarginsBranch = sourceBetween(layoutSource, "const rightChatX = docMaxRight", 'editor.createShapes(shapes)')
  assert.match(bigChatBranch, /type: 'fleet-chat'/)
  assert.match(bigChatBranch, /type: 'fleet-source-editor'/)
  assert.match(bothMarginsBranch, /type: 'fleet-chat'/)
  assert.match(bothMarginsBranch, /type: 'fleet-docview'/)
  assert.match(bothMarginsBranch, /type: 'fleet-source-editor'/)
})
