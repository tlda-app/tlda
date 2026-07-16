import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterPreviewForDropRole,
  inferFleetFilterDropRole,
} from '../src/shapes/fleet-filter-drop-preview.ts'

const bounds = { x: 100, y: 200, w: 300, h: 600 }

test('filter drop role falls back to replace for the visible left only zone', () => {
  assert.equal(inferFleetFilterDropRole(bounds, { x: 150, y: 500 }), 'replace')
})

test('filter drop role falls back to to/from in the right stacked panes', () => {
  assert.equal(inferFleetFilterDropRole(bounds, { x: 250, y: 250 }), 'to')
  assert.equal(inferFleetFilterDropRole(bounds, { x: 250, y: 650 }), 'from')
})

test('filter drop preview selection commits the preview matching the resolved role', () => {
  const state = {
    activePaneRole: null,
    toPreview: [[['to', 'fml5000']]],
    fromPreview: [[['from', 'fml5000']]],
    replacePreview: [[['to', 'fml5000']], [['from', 'fml5000']]],
  }

  const role = inferFleetFilterDropRole(bounds, { x: 150, y: 500 })

  assert.equal(role, 'replace')
  assert.deepEqual(filterPreviewForDropRole(state, role), state.replacePreview)
})
