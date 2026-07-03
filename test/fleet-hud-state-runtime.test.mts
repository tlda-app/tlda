import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FLEET_HUD_EXPANDED_STORAGE_KEY,
  isFleetHudHidden,
  readFleetHudExpanded,
  resolveFleetHudToggle,
  writeFleetHudExpanded,
} from '../src/wm/fleet-hud-state'

const store = new Map<string, string>()

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
  },
})

test('fleet HUD expanded state persists through the WM state contract', () => {
  store.clear()
  assert.equal(readFleetHudExpanded(), false)
  assert.equal(isFleetHudHidden(), true)

  writeFleetHudExpanded(true)
  assert.equal(store.get(FLEET_HUD_EXPANDED_STORAGE_KEY), '1')
  assert.equal(readFleetHudExpanded(), true)
  assert.equal(isFleetHudHidden(), false)

  writeFleetHudExpanded(false)
  assert.equal(store.get(FLEET_HUD_EXPANDED_STORAGE_KEY), '0')
  assert.equal(readFleetHudExpanded(), false)
})

test('fleet HUD toggle resolution preserves explicit requested state', () => {
  assert.equal(resolveFleetHudToggle(false, true), true)
  assert.equal(resolveFleetHudToggle(true, false), false)
  assert.equal(resolveFleetHudToggle(false, undefined), true)
  assert.equal(resolveFleetHudToggle(true, undefined), false)
  assert.equal(resolveFleetHudToggle(true, 'not-a-boolean'), false)
})
