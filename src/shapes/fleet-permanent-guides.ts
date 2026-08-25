/**
 * The snap lines a layout made permanent, and how they are keyed.
 *
 * Skip, 2026-08-25: "the layout chooses which lines it makes permanent." So the
 * layout writes them when it runs, and choosing a layout replaces them — there
 * is no accumulation and nothing to clear.
 *
 * They are page-space coordinates in one project's room, and a layout belongs to
 * one person on one device, so all three are in the key.
 *
 * Separate from fleet-permanent-guide-store.ts so this stays free of the
 * preferences module, which reaches the fleet socket and cannot be loaded
 * outside a browser. Same split, and the same reason, as readingPosition.ts.
 */

import type { FleetNudgeGridGuide } from './fleet-nudge-grid'

export type PermanentGuideMap = Record<string, FleetNudgeGridGuide[]>

export function permanentGuideKey(projectName: string, userId: string, deviceId: string): string {
  return `${projectName}|${userId}|${deviceId}`
}

export function permanentGuidesOf(all: PermanentGuideMap, key: string): FleetNudgeGridGuide[] {
  return all[key] ?? []
}

/** Returns the same object when nothing changes, so a write can be skipped. */
export function withPermanentGuides(
  all: PermanentGuideMap,
  key: string,
  guides: FleetNudgeGridGuide[],
): PermanentGuideMap {
  const current = all[key] ?? []
  if (current.length === 0 && guides.length === 0) return all
  if (JSON.stringify(current) === JSON.stringify(guides)) return all
  const next = { ...all }
  if (guides.length === 0) delete next[key]
  else next[key] = guides
  return next
}
