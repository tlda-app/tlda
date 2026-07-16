import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import test from 'node:test'

const productionFiles = [
  'src/SvgDocument.tsx',
  'src/shapes/fleet-layout-plan.ts',
  'src/shapes/fleet-panel-registry.ts',
  'src/shapes/fleet-utils.ts',
  'src/pills/FleetIconPill.tsx',
  'src/panels/PrefsTab.tsx',
  'src/overlays/FleetHUD.css',
  'src/overlays/useFleetGestures.ts',
  'src/shapes/fleet-inbox.css',
  'src/shapes/fleet-chat.css',
  'src/livePerfProbe.ts',
  'server/lib/sync-rooms.mjs',
  'shared/shapes/fleet-panel-schema.mjs',
]

const forbidden = [
  'fleet-touch-inbox',
  'FleetTouchInbox',
  'fleetTouchInboxProps',
  'touch-inbox',
  'phone-inbox-surface',
  'phone-lane-surface',
  'fleet-inbox-pop-zone',
  'fleet-inbox-agents-mini-chat',
  'fleet-inbox-phone-agent',
]

test('old touch/fleet-touch-inbox second system has no production paths', () => {
  for (const file of productionFiles) {
    const text = readFileSync(file, 'utf8')
    for (const token of forbidden) {
      assert.equal(text.includes(token), false, `${file} still contains ${token}`)
    }
  }
})

test('touch layout variant is not materialized by the fleet layout planner', () => {
  const text = readFileSync('src/shapes/fleet-layout-plan.ts', 'utf8')
  assert.doesNotMatch(text, /FleetLayoutVariant\\s*=\\s*[^\\n]*['"]touch['"]/)
  assert.doesNotMatch(text, /variant\\s*={2,3}\\s*['"]touch['"]/)
})

test('deleted touch container implementation stays deleted', () => {
  assert.equal(existsSync('src/shapes/FleetTouchInboxShape.tsx'), false)
  assert.equal(existsSync('src/shapes/fleet-touch-inbox.css'), false)
})
