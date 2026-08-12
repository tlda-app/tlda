import type { Editor } from 'tldraw'
import type { FleetNudgeGuide } from './fleet-utils'

/**
 * The guides for the soft snap currently in effect. Written by the translate
 * handler (which is where the match is computed) and read by the overlay that
 * draws them, so the drag path stays free of React.
 *
 * The editor travels with them: a fleet panel can be dragged on the HUD layer,
 * which has its own editor, and only that editor can project its own pages.
 */
export type FleetNudgeGuideState = { editor: Editor; guides: FleetNudgeGuide[] } | null

let current: FleetNudgeGuideState = null
const listeners = new Set<(state: FleetNudgeGuideState) => void>()

export function setFleetNudgeGuides(editor: Editor, guides: FleetNudgeGuide[]) {
  if (guides.length === 0 && current === null) return
  current = guides.length === 0 ? null : { editor, guides }
  for (const listener of listeners) listener(current)
}

export function clearFleetNudgeGuides() {
  if (current === null) return
  current = null
  for (const listener of listeners) listener(current)
}

export function getFleetNudgeGuides(): FleetNudgeGuideState {
  return current
}

export function onFleetNudgeGuides(listener: (state: FleetNudgeGuideState) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
