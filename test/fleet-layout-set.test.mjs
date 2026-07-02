import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pillSource = readFileSync(new URL('../src/pills/FleetIconPill.tsx', import.meta.url), 'utf8')
const pillShapeSource = readFileSync(new URL('../src/shapes/FleetPillShape.tsx', import.meta.url), 'utf8')
const chatShapeSource = readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
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

test('touch layout control opens picker on pointerup without waiting for click', () => {
  const onUp = sourceBetween(pillSource, 'const onUp = (ev: PointerEvent) => {', 'const onCancel')
  assert.match(onUp, /isTouchLayoutControl\(\)/)
  assert.match(onUp, /setPickerOpen\(open => !open\)/)
  assert.match(onUp, /justDraggedRef\.current = true/)
})

test('agent pill drops create owned fleet chats without raw canvas creation', () => {
  const dropPill = sourceBetween(pillShapeSource, 'export async function dropPillOnTarget', 'export class FleetPillShapeUtil')
  assert.match(dropPill, /props: \{ \.\.\.hitShape\.props, filter: newFilter \}/)
  assert.match(dropPill, /createFleetShape\(editor, 'fleet-chat', pagePoint\.x, pagePoint\.y/)
  assert.equal(dropPill.includes("createShape({\n      id: createShapeId(),\n      type: 'fleet-chat'"), false)
})

test('layout swap deletes all owned fleet shapes before recreating the preset', () => {
  const inner = sourceBetween(layoutSource, 'function _createFleetLayoutInner', 'const humanId = getHumanId()')
  assert.match(inner, /const existing = editor\.getCurrentPageShapes\(\)\.filter\(s => isFleetShapeForOwnerKey\(s, myId, myDevice\)\)/)
  assert.match(inner, /if \(existing\.length > 0\) forceDeleteShapes\(editor, existing\.map\(s => s\.id as string\)\)/)
})

test('filter overlay updates locked chats by temporarily unlocking them', () => {
  const overlay = sourceBetween(chatShapeSource, 'export function FilterOverlay', '// Detect pill hovering over the shape')
  assert.match(overlay, /const updateChatProps = useCallback/)
  assert.match(overlay, /isLocked: false/)
  assert.match(overlay, /isLocked: true/)
  assert.match(overlay, /addEventListener\('pointerup', handlePointerUp/)
  assert.match(overlay, /updateChatProps\(\{ filter: nextFilter, trafficMode: 'normal' \}\)/)
  assert.match(overlay, /updateChatProps\(\{ filter: newFilter \}\)/)
  assert.match(overlay, /updateChatProps\(\{ filter: \[\] \}\)/)
})

test('fleet panel layout buttons unlock before selecting for resize or move', () => {
  assert.match(layoutSource, /export function selectFleetShapeForLayout/)
  assert.match(layoutSource, /isLocked: false/)
  assert.match(layoutSource, /editor\.setCurrentTool\('select'\)/)
  assert.match(layoutSource, /editor\.select\(shape\.id\)/)
  assert.match(chatShapeSource, /selectFleetShapeForLayout\(editor, shape\)/)
})

test('inbox filter target allows multiple chats for the same owner device', () => {
  const inboxSource = readFileSync(new URL('../src/shapes/FleetInboxShape.tsx', import.meta.url), 'utf8')
  const resolver = sourceBetween(inboxSource, 'const resolvePhoneChat = useCallback', 'const phoneChat = useValue')
  assert.match(resolver, /if \(chats\.length === 0\) return null/)
  assert.match(resolver, /if \(chats\.length === 1\) return chats\[0\]/)
  assert.doesNotMatch(resolver, /chats\.length === 1 \?/)
  assert.match(resolver, /fleet-chat-0-/)
  assert.match(resolver, /sort\(\(a, b\) => score\(a\) - score\(b\)/)
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
