import type { Editor } from 'tldraw'

export const FLEET_HUD_RESET_EVENT = 'fleet-hud-reset'
export const FLEET_HUD_TOGGLE_EVENT = 'fleet-hud-toggle'
export const FLEET_HUD_WRAP_EVENT = 'fleet-hud-wrap'

export type FleetHudResetDetail = {
  preserveAnchor?: boolean
}

/** How far the document's top-left corner moved when the layout was wrapped
 *  around a new document. The panels have already been translated by it. */
export type FleetHudWrapDetail = {
  dx: number
  dy: number
}

export type FleetHudToggleDetail = {
  expanded?: boolean
}

declare global {
  interface Window {
    __tldraw_hud_editor__?: Editor
  }
}

function hasWindow(): boolean {
  return typeof window !== 'undefined'
}

export function getMainEditor(fallback?: Editor): Editor | undefined {
  if (!hasWindow()) return fallback
  return (window as Window & { __tldraw_editor__?: Editor }).__tldraw_editor__ || fallback
}

export function getHudEditor(): Editor | null {
  if (!hasWindow()) return null
  return window.__tldraw_hud_editor__ || null
}

export function setHudEditor(editor: Editor | null | undefined): void {
  if (!hasWindow()) return
  if (editor) window.__tldraw_hud_editor__ = editor
  else delete window.__tldraw_hud_editor__
}

export function markMainEditorHistoryStoppingPoint(fallback: Editor): void {
  getMainEditor(fallback)?.markHistoryStoppingPoint?.()
}

export function getFleetToolPlacementZoom(fallback: Editor): number {
  return getHudEditor()?.getCamera().z ?? fallback.getZoomLevel()
}

export function dispatchFleetHudReset(detail?: FleetHudResetDetail): void {
  if (!hasWindow()) return
  try { window.dispatchEvent(new CustomEvent(FLEET_HUD_RESET_EVENT, detail ? { detail } : undefined)) } catch {}
}

export function dispatchFleetHudWrap(detail: FleetHudWrapDetail): void {
  if (!hasWindow()) return
  window.dispatchEvent(new CustomEvent(FLEET_HUD_WRAP_EVENT, { detail }))
}

export function dispatchFleetHudToggle(detail?: FleetHudToggleDetail): void {
  if (!hasWindow()) return
  try { window.dispatchEvent(new CustomEvent(FLEET_HUD_TOGGLE_EVENT, detail ? { detail } : undefined)) } catch {}
}
