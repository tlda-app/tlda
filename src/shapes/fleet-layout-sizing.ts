export const FLEET_CHAT_VIEWPORT_INSET_PX = 8
export const FLEET_HUD_DEFAULT_TOP_PAD_PX = 80
export const FLEET_HUD_VIEWPORT_FRAME_TOP_PX = 20

export type FleetLayoutViewportSize = { w: number; h: number }

export function currentVisibleViewportSize(): FleetLayoutViewportSize | null {
  if (typeof window === 'undefined') return null
  const vv = window.visualViewport
  const w = Number(vv?.width || window.innerWidth || 0)
  const h = Number(vv?.height || window.innerHeight || 0)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return { w, h }
}

export function singleChatViewportPanelSize(
  viewport: FleetLayoutViewportSize,
  topPad = FLEET_HUD_DEFAULT_TOP_PAD_PX,
): FleetLayoutViewportSize {
  const inset = FLEET_CHAT_VIEWPORT_INSET_PX
  const availableW = Math.max(1, Math.round(viewport.w - inset * 2))
  const availableH = Math.max(1, Math.round(viewport.h - topPad - FLEET_HUD_VIEWPORT_FRAME_TOP_PX - inset))
  const h = availableH
  const w = Math.min(availableW, h)
  return { w, h }
}
