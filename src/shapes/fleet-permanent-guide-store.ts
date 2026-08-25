/**
 * Permanent snap lines as they are actually held: in the per-user `fleet_prefs`
 * row on the server, under one key.
 *
 * Reads are synchronous off the prefs cache, which is populated at login,
 * because the drag path cannot wait on a round trip. A lost write costs the
 * lines of one layout, and choosing that layout again writes them.
 *
 * Same shape and same reasoning as readingPositionStore.ts.
 */

import { getPref, setPref } from '../preferences'
import type { FleetNudgeGridGuide } from './fleet-nudge-grid'
import { permanentGuideKey, permanentGuidesOf, withPermanentGuides } from './fleet-permanent-guides'

function currentProjectName(): string {
  if (typeof window === 'undefined') return 'document'
  return new URLSearchParams(window.location.search).get('project') || 'document'
}

export function readPermanentGuides(userId: string, deviceId: string): FleetNudgeGridGuide[] {
  if (!userId || !deviceId) return []
  return permanentGuidesOf(
    getPref('layout-permanent-guides'),
    permanentGuideKey(currentProjectName(), userId, deviceId),
  )
}

export function writePermanentGuides(userId: string, deviceId: string, guides: FleetNudgeGridGuide[]) {
  if (!userId || !deviceId) return
  const all = getPref('layout-permanent-guides')
  const next = withPermanentGuides(all, permanentGuideKey(currentProjectName(), userId, deviceId), guides)
  if (next !== all) setPref('layout-permanent-guides', next)
}
