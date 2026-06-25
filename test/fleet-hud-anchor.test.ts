import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeFleetHudDefaultAnchor } from '../src/overlays/fleet-hud-anchor.ts'
import type { PageBounds } from '../src/overlays/fleet-bounds.ts'

const fleetBounds: PageBounds = { x: -9355, y: -1200, w: 1335, h: 621 }
const docPageLeft = 0
const layoutDx = -8000
const topPad = 80

function gapFromLayoutRightToDocumentMargin(docLeftScreen: number, panOffset: number): number {
  const projectedFleetRight = fleetBounds.x + fleetBounds.w + panOffset
  return docLeftScreen - projectedFleetRight
}

function oldViewportClampedPanOffset(docLeftScreen: number, viewportWidth: number): number {
  const panOffset = docLeftScreen - docPageLeft - layoutDx
  const projectedLeft = fleetBounds.x + panOffset
  const projectedRight = projectedLeft + fleetBounds.w
  if (projectedRight < viewportWidth * 0.25 || projectedLeft > viewportWidth * 0.75) {
    return 20 - fleetBounds.x
  }
  return panOffset
}

test('default fleet HUD anchor keeps right-edge margin gap stable across camera positions', () => {
  const nearDoc = computeFleetHudDefaultAnchor({
    bounds: fleetBounds,
    docPageLeft,
    docLeftScreen: 400,
    layoutDx,
    topPad,
  })
  const pannedAway = computeFleetHudDefaultAnchor({
    bounds: fleetBounds,
    docPageLeft,
    docLeftScreen: 1800,
    layoutDx,
    topPad,
  })

  assert.equal(nearDoc.cameraY, topPad - fleetBounds.y)
  assert.equal(pannedAway.cameraY, nearDoc.cameraY)
  assert.equal(
    gapFromLayoutRightToDocumentMargin(400, nearDoc.panOffset),
    gapFromLayoutRightToDocumentMargin(1800, pannedAway.panOffset),
  )
})

test('old viewport clamp made the same default layout camera-position dependent', () => {
  const nearDocGap = gapFromLayoutRightToDocumentMargin(
    400,
    oldViewportClampedPanOffset(400, 1920),
  )
  const pannedAwayGap = gapFromLayoutRightToDocumentMargin(
    1800,
    oldViewportClampedPanOffset(1800, 1920),
  )

  assert.notEqual(nearDocGap, pannedAwayGap)
})
