import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pillSource = readFileSync(new URL('../src/pills/FleetIconPill.tsx', import.meta.url), 'utf8')
const syncErrorPillSource = readFileSync(new URL('../src/pills/SyncErrorPill.tsx', import.meta.url), 'utf8')
const svgDocumentSource = readFileSync(new URL('../src/SvgDocument.tsx', import.meta.url), 'utf8')
const pillShapeSource = readFileSync(new URL('../src/shapes/FleetPillShape.tsx', import.meta.url), 'utf8')
const chatShapeSource = readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
const agentsShapeSource = readFileSync(new URL('../src/shapes/FleetAgentsShape.tsx', import.meta.url), 'utf8')
const searchShapeSource = readFileSync(new URL('../src/shapes/FleetSearchShape.tsx', import.meta.url), 'utf8')
const docviewShapeSource = readFileSync(new URL('../src/shapes/FleetDocViewShape.tsx', import.meta.url), 'utf8')
const sourceEditorShapeSource = readFileSync(new URL('../src/shapes/FleetSourceEditorShape.tsx', import.meta.url), 'utf8')
const reaperShapeSource = readFileSync(new URL('../src/shapes/ReaperShape.tsx', import.meta.url), 'utf8')
const inboxShapeSource = readFileSync(new URL('../src/shapes/FleetInboxShape.tsx', import.meta.url), 'utf8')
const touchInboxShapeSource = readFileSync(new URL('../src/shapes/FleetTouchInboxShape.tsx', import.meta.url), 'utf8')
const notificationsShapeSource = readFileSync(new URL('../src/shapes/FleetNotificationsShape.tsx', import.meta.url), 'utf8')
const layoutSource = readFileSync(new URL('../src/shapes/fleet-utils.ts', import.meta.url), 'utf8')
const fleetHudSource = readFileSync(new URL('../src/overlays/FleetHUD.tsx', import.meta.url), 'utf8')
const fleetToolGhostSource = readFileSync(new URL('../src/overlays/FleetToolGhost.tsx', import.meta.url), 'utf8')
const panelRegistrySource = readFileSync(new URL('../src/shapes/fleet-panel-registry.ts', import.meta.url), 'utf8')
const ownershipSource = readFileSync(new URL('../src/shapes/fleet-ownership.ts', import.meta.url), 'utf8')
const layoutContextSource = readFileSync(new URL('../src/shapes/fleet-layout-context.ts', import.meta.url), 'utf8')
const layoutGeometrySource = readFileSync(new URL('../src/shapes/fleet-layout-geometry.ts', import.meta.url), 'utf8')
const layoutPlanSource = readFileSync(new URL('../src/shapes/fleet-layout-plan.ts', import.meta.url), 'utf8')
const layoutSeedingSource = readFileSync(new URL('../src/shapes/fleet-layout-seeding.ts', import.meta.url), 'utf8')
const syncRoomsSource = readFileSync(new URL('../server/lib/sync-rooms.mjs', import.meta.url), 'utf8')
const fleetPanelSchemaSource = readFileSync(new URL('../shared/shapes/fleet-panel-schema.mjs', import.meta.url), 'utf8')
const editorHostBridgeSource = readFileSync(new URL('../src/wm/editor-host-bridge.ts', import.meta.url), 'utf8')
const fleetHudStateSource = readFileSync(new URL('../src/wm/fleet-hud-state.ts', import.meta.url), 'utf8')
const hostedPanelRegistrySource = readFileSync(new URL('../src/wm/hosted-panel-registry.ts', import.meta.url), 'utf8')

function sourceBetween(source, start, end) {
  const startIdx = source.indexOf(start)
  assert.notEqual(startIdx, -1, `missing start marker: ${start}`)
  const endIdx = source.indexOf(end, startIdx + start.length)
  assert.notEqual(endIdx, -1, `missing end marker after ${start}: ${end}`)
  return source.slice(startIdx, endIdx)
}

const fleetPanelTypes = [
  'fleet-chat',
  'fleet-agents',
  'fleet-search',
  'fleet-docview',
  'fleet-source-editor',
  'fleet-reaper',
  'fleet-inbox',
  'fleet-touch-inbox',
  'fleet-notifications',
]

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

test('fleet panel registry owns panel types, defaults, and tool dimensions', () => {
  assert.match(layoutSource, /from '\.\/fleet-panel-registry'/)
  assert.match(layoutSource, /export \{[\s\S]*FLEET_PANEL_REGISTRY[\s\S]*\} from '\.\/fleet-panel-registry'/)
  assert.match(panelRegistrySource, /from '\.\.\/wm\/hosted-panel-registry'/)
  assert.match(hostedPanelRegistrySource, /export type HostedPanelAppDefinition/)
  assert.match(hostedPanelRegistrySource, /export function defineHostedPanelApps/)
  assert.match(hostedPanelRegistrySource, /export function hostedPanelAppMap/)
  assert.match(hostedPanelRegistrySource, /export function hostedPanelSizeMap/)
  assert.match(hostedPanelRegistrySource, /export function hostedPanelDefaultProps/)
  const registryTypes = [...panelRegistrySource.matchAll(/type: '(fleet-[^']+)'/g)].map(match => match[1])
  assert.deepEqual(registryTypes, fleetPanelTypes)
  assert.match(panelRegistrySource, /export type FleetPanelDefinition = HostedPanelAppDefinition<FleetPanelType>/)
  assert.match(panelRegistrySource, /defineHostedPanelApps\(\[/)
  assert.match(panelRegistrySource, /hostedPanelAppMap\(FLEET_PANEL_DEFINITIONS\)/)
  assert.match(panelRegistrySource, /hostedPanelSizeMap\(FLEET_PANEL_DEFINITIONS\)/)
  assert.match(panelRegistrySource, /hostedPanelDefaultProps\(FLEET_PANEL_REGISTRY, type\)/)
  assert.match(panelRegistrySource, /type: 'fleet-chat'[\s\S]*defaultSize: \{ w: 400, h: 600 \}[\s\S]*defaultProps: \{ filter: \[\] \}/)
  assert.match(panelRegistrySource, /type: 'fleet-source-editor'[\s\S]*defaultProps: \{ file: '', line: 1, title: 'Source' \}/)
  assert.match(panelRegistrySource, /export const FLEET_TOOL_DIMS/)
  assert.match(layoutSource, /\.\.\.fleetPanelDefaultProps\(input\.type\), \.\.\.input\.props/)
})

test('fleet panel client and server schemas share prop definitions', () => {
  const clientSources = {
    fleetChatProps: chatShapeSource,
    fleetAgentsProps: agentsShapeSource,
    fleetSearchProps: searchShapeSource,
    fleetDocviewProps: docviewShapeSource,
    fleetSourceEditorProps: sourceEditorShapeSource,
    fleetReaperProps: reaperShapeSource,
    fleetInboxProps: inboxShapeSource,
    fleetTouchInboxProps: touchInboxShapeSource,
    fleetNotificationsProps: notificationsShapeSource,
  }
  assert.match(syncRoomsSource, /from '\.\.\/\.\.\/shared\/shapes\/fleet-panel-schema\.mjs'/)
  assert.match(fleetPanelSchemaSource, /const ownedPanelProps = \{[\s\S]*userId: T\.optional\(T\.string\),[\s\S]*deviceId: T\.optional\(T\.string\),/)
  assert.match(fleetPanelSchemaSource, /export const fleetChatProps = \{[\s\S]*filter: T\.arrayOf\(T\.arrayOf\(T\.arrayOf\(T\.string\)\)\),[\s\S]*trafficMode: T\.optional\(T\.string\),/)
  assert.match(fleetPanelSchemaSource, /export const fleetDocviewProps = \{[\s\S]*sources: T\.optional\(T\.string\),/)
  assert.match(fleetPanelSchemaSource, /export const fleetSourceEditorProps = \{[\s\S]*file: T\.string,[\s\S]*line: T\.number,[\s\S]*title: T\.string,/)
  for (const [propsName, source] of Object.entries(clientSources)) {
    assert.match(source, new RegExp(`static override props = ${propsName}`), `${propsName} missing from client shape`)
    assert.match(syncRoomsSource, new RegExp(`props: ${propsName}`), `${propsName} missing from server sync schema`)
  }
  for (const type of fleetPanelTypes) {
    assert.match(syncRoomsSource, new RegExp(`'${type}': \\{[\\s\\S]*sequenceId: 'com\\.tldraw\\.shape\\.${type}'`), `${type} missing from server schemas`)
  }
})

test('fleet ownership module owns anchors and owner predicates', () => {
  assert.match(layoutSource, /from '\.\/fleet-ownership'/)
  assert.match(layoutSource, /export \{[\s\S]*getMyAnchorId[\s\S]*isFleetShapeForOwnerKey[\s\S]*isMyFleetShape[\s\S]*\} from '\.\/fleet-ownership'/)
  assert.match(ownershipSource, /export const FLEET_HUD_ANCHOR_ID = 'shape:fleet-hud-anchor'/)
  assert.match(ownershipSource, /getAnchorIdForOwnerKey\(uid, dev\)/)
  assert.match(ownershipSource, /return isFleetShapeForOwnerKey\(s, myId, myDevice\)/)
})

test('fleet layout geometry module owns offsets and lane disjointness', () => {
  assert.match(layoutSource, /from '\.\/fleet-layout-geometry'/)
  assert.match(layoutSource, /export \{ ensureMyLaneDisjoint, laneDy, layoutOffset \} from '\.\/fleet-layout-geometry'/)
  assert.match(layoutGeometrySource, /export function layoutOffset/)
  assert.match(layoutGeometrySource, /const LANE_STEP = 20000/)
  assert.match(layoutGeometrySource, /export function laneDy/)
  assert.match(layoutGeometrySource, /export function ensureMyLaneDisjoint/)
})

test('fleet layout plan module owns default layout shape construction', () => {
  assert.match(layoutSource, /from '\.\/fleet-layout-plan'/)
  assert.match(layoutSource, /from '\.\/fleet-layout-context'/)
  assert.match(layoutSource, /getDocumentPageBounds/)
  assert.match(layoutSource, /getPhoneLayoutTarget/)
  assert.match(layoutSource, /function layoutSlotId/)
  assert.match(layoutSource, /planFleetLayoutShapes\(buildFleetLayoutPlanInput\(\{[\s\S]*variant,[\s\S]*myId,[\s\S]*myDevice,[\s\S]*makeSlotId: slot => layoutSlotId\(myId, myDevice, slot\),/)
  assert.match(layoutSource, /editor\.createShapes\(layoutPlan\.shapes as any\)/)
  assert.equal(layoutPlanSource.includes("from 'tldraw'"), false)
  assert.match(layoutContextSource, /export function buildFleetLayoutPlanInput/)
  assert.match(layoutContextSource, /export function getDocumentPageBounds/)
  assert.match(layoutContextSource, /export function getPhoneLayoutTarget/)
  assert.match(layoutPlanSource, /export function planFleetLayoutShapes/)
  assert.match(layoutPlanSource, /makeSlotId: \(slot: string\) => string/)
  assert.match(layoutPlanSource, /function panelShape/)
  assert.match(layoutPlanSource, /fleetPanelDefaultProps\(type\)/)
  assert.equal(layoutSource.includes("id: layoutSlotId(myId, myDevice, 'chat-0')"), false)
})

test('fleet layout seeding module owns recent-agent chat filter defaults', () => {
  assert.match(layoutSource, /from '\.\/fleet-layout-seeding'/)
  assert.match(layoutContextSource, /defaultFleetLayoutChatFilters\(\{[\s\S]*agents,[\s\S]*humanId: myId,[\s\S]*existingChatFilters,[\s\S]*panelCount/)
  assert.match(layoutSeedingSource, /recentChatTargetAgents/)
  assert.match(layoutSeedingSource, /getEvents\(\)/)
  assert.match(layoutSeedingSource, /getHumanName\(\)/)
  assert.match(layoutSeedingSource, /return name \? \[\[\['from', name\]\], \[\['to', name\]\]\] : \[\]/)
})

test('WM host editor bridge owns HUD editor globals for tool placement', () => {
  assert.match(editorHostBridgeSource, /export function getMainEditor/)
  assert.match(editorHostBridgeSource, /export function getHudEditor/)
  assert.match(editorHostBridgeSource, /export function setHudEditor/)
  assert.match(editorHostBridgeSource, /export function markMainEditorHistoryStoppingPoint/)
  assert.match(editorHostBridgeSource, /export function getFleetToolPlacementZoom/)
  assert.match(editorHostBridgeSource, /export function dispatchFleetHudReset/)
  assert.match(editorHostBridgeSource, /export function dispatchFleetHudToggle/)
  assert.match(layoutSource, /from '\.\.\/wm\/editor-host-bridge'/)
  assert.match(layoutSource, /markMainEditorHistoryStoppingPoint\(editor\)/)
  assert.match(layoutSource, /const hudEditor = getHudEditor\(\)/)
  assert.match(layoutSource, /dispatchFleetHudReset\(\)/)
  assert.equal(layoutSource.includes('__tldraw_editor__'), false)
  assert.equal(layoutSource.includes('__tldraw_hud_editor__'), false)
  assert.equal(layoutSource.includes("'fleet-hud-reset'"), false)
  assert.match(fleetHudSource, /from '\.\.\/wm\/editor-host-bridge'/)
  assert.match(fleetHudSource, /FLEET_HUD_RESET_EVENT/)
  assert.match(fleetHudSource, /FLEET_HUD_TOGGLE_EVENT/)
  assert.match(fleetHudSource, /setHudEditor\(e\)/)
  assert.match(fleetHudSource, /addEventListener\(FLEET_HUD_RESET_EVENT, onReset\)/)
  assert.match(fleetHudSource, /addEventListener\(FLEET_HUD_TOGGLE_EVENT, onToggle\)/)
  assert.equal(fleetHudSource.includes('__tldraw_hud_editor__'), false)
  assert.match(fleetToolGhostSource, /from '\.\.\/wm\/editor-host-bridge'/)
  assert.match(fleetToolGhostSource, /getFleetToolPlacementZoom\(editor\)/)
  assert.equal(fleetToolGhostSource.includes('__tldraw_hud_editor__'), false)
  assert.match(pillSource, /dispatchFleetHudToggle\(\{ expanded \}\)/)
  assert.match(pillSource, /dispatchFleetHudReset\(\)/)
  assert.match(syncErrorPillSource, /dispatchFleetHudToggle\(\{ expanded: true \}\)/)
  assert.match(syncErrorPillSource, /dispatchFleetHudReset\(\)/)
  assert.match(svgDocumentSource, /dispatchFleetHudReset\(\{ preserveAnchor: true \}\)/)
  assert.equal(pillSource.includes("new CustomEvent('fleet-hud-"), false)
  assert.equal(syncErrorPillSource.includes("new CustomEvent('fleet-hud-"), false)
  assert.equal(svgDocumentSource.includes("new CustomEvent('fleet-hud-reset'"), false)
})

test('WM HUD state module owns expanded-state persistence', () => {
  assert.match(fleetHudStateSource, /export const FLEET_HUD_EXPANDED_STORAGE_KEY = 'fleet-hud-expanded'/)
  assert.match(fleetHudStateSource, /export function readFleetHudExpanded/)
  assert.match(fleetHudStateSource, /export function writeFleetHudExpanded/)
  assert.match(fleetHudStateSource, /export function isFleetHudHidden/)
  assert.match(fleetHudStateSource, /export function resolveFleetHudToggle/)
  assert.match(fleetHudSource, /from '\.\.\/wm\/fleet-hud-state'/)
  assert.match(fleetHudSource, /useState\(readFleetHudExpanded\)/)
  assert.match(fleetHudSource, /resolveFleetHudToggle\(prev, requested\)/)
  assert.match(fleetHudSource, /writeFleetHudExpanded\(next\)/)
  assert.match(pillSource, /from '\.\.\/wm\/fleet-hud-state'/)
  assert.match(pillSource, /isFleetHudHidden\(\)/)
  assert.match(pillSource, /writeFleetHudExpanded\(expanded\)/)
  assert.match(syncErrorPillSource, /from '\.\.\/wm\/fleet-hud-state'/)
  assert.match(syncErrorPillSource, /writeFleetHudExpanded\(true\)/)
  assert.equal(fleetHudSource.includes("'fleet-hud-expanded'"), false)
  assert.equal(pillSource.includes("'fleet-hud-expanded'"), false)
  assert.equal(syncErrorPillSource.includes("'fleet-hud-expanded'"), false)
})

test('owned panel creation adapter covers touch-inbox child chat', () => {
  const childCreation = sourceBetween(touchInboxShapeSource, 'const createChildChat = async () => {', 'void createChildChat()')
  assert.match(layoutSource, /export type OwnedFleetPanelCreateInput/)
  assert.match(layoutSource, /export async function createOwnedFleetPanelShape/)
  assert.match(layoutSource, /\.\.\.fleetPanelDefaultProps\(input\.type\), \.\.\.input\.props, userId: myId, deviceId: myDevice/)
  assert.match(layoutSource, /return createOwnedFleetPanelShape\(editor, \{ type, x, y, props \}\)/)
  assert.match(childCreation, /createOwnedFleetPanelShape\(mainEd, \{[\s\S]*type: 'fleet-chat'[\s\S]*parentId: shape\.id[\s\S]*props: \{ w: myW, h: Math\.max\(80, myH - STRIP_H\), filter: \[\] \}[\s\S]*markHistoryStoppingPoint: false/)
  assert.equal(childCreation.includes('getHumanId'), false)
  assert.equal(childCreation.includes('getDeviceId'), false)
  assert.equal(childCreation.includes('userId:'), false)
  assert.equal(childCreation.includes('deviceId:'), false)
})

test('layout swap deletes all owned fleet shapes before recreating the preset', () => {
  const inner = sourceBetween(layoutSource, 'function _createFleetLayoutInner', 'const layoutPlan = planFleetLayoutShapes')
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
  const gridBranch = sourceBetween(layoutPlanSource, "} else if (variant === '2x2')", "} else if (variant === '3-col')")
  const chatCount = (gridBranch.match(/panelShape\('fleet-chat'/g) || []).length
  assert.equal(chatCount, 4)
  assert.equal(gridBranch.includes("panelShape('fleet-docview'"), false)
})

test('big-chat and both-margins create their expected reading/writing panels', () => {
  const bigChatBranch = sourceBetween(layoutPlanSource, "variant === 'big-chat'", "} else if (variant === '2x2')")
  const bothMarginsBranch = sourceBetween(layoutPlanSource, "const rightChatX = docMaxRight", 'return { shapes, dispatchHudReset: false }')
  assert.match(bigChatBranch, /panelShape\('fleet-chat'/)
  assert.match(bigChatBranch, /panelShape\('fleet-source-editor'/)
  assert.match(bothMarginsBranch, /panelShape\('fleet-chat'/)
  assert.match(bothMarginsBranch, /panelShape\('fleet-docview'/)
  assert.match(bothMarginsBranch, /panelShape\('fleet-source-editor'/)
})
