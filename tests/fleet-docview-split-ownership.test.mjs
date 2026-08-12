import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { shouldRepairFleetPanelOwnership } from '../src/shapes/fleet-owner-repair.ts'

const docviewSource = readFileSync(new URL('../src/shapes/FleetDocViewShape.tsx', import.meta.url), 'utf8')
const fleetUtilsSource = readFileSync(new URL('../src/shapes/fleet-utils.ts', import.meta.url), 'utf8')

test('docview split creates owned fleet panels', () => {
  assert.match(docviewSource, /createOwnedFleetPanelShape\(mainEditor/)
  assert.doesNotMatch(docviewSource, /mainEditor\.createShape\(\{\s*id:\s*newId,\s*type:\s*'fleet-docview'/)
})

test('layout selection repairs clicked panels with incomplete ownership before entering HUD layout', () => {
  assert.equal(shouldRepairFleetPanelOwnership(true, {}), true)
  assert.equal(shouldRepairFleetPanelOwnership(true, { userId: 'fleet:other' }), true)
  assert.equal(shouldRepairFleetPanelOwnership(true, { deviceId: 'device' }), true)
  assert.equal(shouldRepairFleetPanelOwnership(true, { userId: 'fleet:other', deviceId: 'device' }), false)
  assert.equal(shouldRepairFleetPanelOwnership(false, {}), false)
  assert.match(fleetUtilsSource, /props:\s*\{\s*\.\.\.currentProps,\s*userId:\s*myId,\s*deviceId:\s*myDevice\s*\}/)
  assert.match(fleetUtilsSource, /withFleetLayoutSelectionIntent\(currentShape\.id/)
})
