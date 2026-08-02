export const FLEET_CHAT_VIEWPORT_INSET_PX = 8
export const FLEET_HUD_DEFAULT_TOP_PAD_PX = 80
export const FLEET_HUD_VIEWPORT_FRAME_TOP_PX = 20

export type FleetLayoutViewportSize = { w: number; h: number }

/**
 * The viewport a layout is sized against, in the same units the HUD draws in.
 *
 * `visualViewport` is measured in VISUAL pixels: it divides by the pinch-zoom
 * scale, so a session zoomed out to 0.53 reports a viewport nearly twice the
 * screen. The HUD draws its panels at 1:1 in LAYOUT pixels — that is what keeps
 * them legible at any canvas zoom — so sizing a layout from the raw visual
 * viewport mixes two unit systems, and the layout comes out scaled by 1/scale
 * against the screen it has to fit on.
 *
 * Multiplying the scale back out reconciles them and keeps the reason
 * visualViewport is read at all: when the on-screen keyboard shrinks the visible
 * area the scale is 1, so the shrunken height still comes through.
 *
 * Skip's iPad had a layout of 2722x1098 where the same code produces 1430x584 at
 * scale 1 — 1.90 and 1.88 times too big, one factor on both axes, which is a
 * zoom rather than a different screen.
 */
export function currentVisibleViewportSize(): FleetLayoutViewportSize | null {
  if (typeof window === 'undefined') return null
  const vv = window.visualViewport
  const scale = Number(vv?.scale) || 1
  const w = Number(vv?.width ? vv.width * scale : window.innerWidth || 0)
  const h = Number(vv?.height ? vv.height * scale : window.innerHeight || 0)
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
