import type { Editor } from 'tldraw'
import { getLayoutReadabilityTokens } from '../readabilityProfile'
import { isCanvasPageShape, isDocumentPageShape } from './document-pages'
import { laneDy, layoutOffset } from './fleet-layout-geometry'
import type { FleetLayoutPlanInput, FleetLayoutVariant } from './fleet-layout-plan'
import { defaultFleetLayoutChatFilters, type FleetChatFilter } from './fleet-layout-seeding'

export type DocumentPageBounds = {
  pageShapes: any[]
  minLeft: number
  minTop: number
  maxRight: number
}

export type FleetLayoutViewportBounds = { x: number; y: number; w: number; h: number }

export function fleetLayoutPanelCount(variant: string): number {
  return variant === '2x2' ? 4 : variant === 'big-chat' ? 1 : 2
}

export function buildFleetLayoutPlanInput({
  editor,
  agents,
  variant,
  myId,
  myDevice,
  docBounds,
  existingChatFilters,
  makeSlotId,
  viewport,
}: {
  editor: Editor
  agents: any[]
  variant: FleetLayoutVariant | string
  myId: string
  myDevice: string
  docBounds: DocumentPageBounds
  existingChatFilters: Array<FleetChatFilter | undefined>
  makeSlotId: (slot: string) => string
  viewport?: FleetLayoutViewportBounds
}): FleetLayoutPlanInput {
  const panelCount = fleetLayoutPanelCount(variant)
  const [filter1 = [], filter2 = [], filter3 = [], filter4 = []] = defaultFleetLayoutChatFilters({
    agents,
    humanId: myId,
    existingChatFilters,
    panelCount,
  })

  const vp = viewport ?? editor.getViewportScreenBounds()
  const layoutTokens = getLayoutReadabilityTokens(vp)
  const leftW = layoutTokens.leftW
  const gap = layoutTokens.gap
  const chatW3 = layoutTokens.chatW
  const marginGap = layoutTokens.marginGap
  const rightW = chatW3 * 2 + gap
  // HUD renders fleet shapes via a z=1 camera (see FleetHUD.tsx), so page units
  // map 1:1 to screen px — size off the raw viewport, not the main-camera zoom.
  const totalH = layoutTokens.totalH
  const agentsH = Math.min(Math.round(totalH * 0.42), Math.max(220, Math.round(totalH * 0.38)))
  const searchH = totalH - gap - agentsH
  const rightChatH = Math.round(totalH * 0.75)
  const docviewH = totalH - gap - rightChatH

  // Width of the content that sits in the LEFT margin (rail + its chat
  // columns). Its right edge is anchored marginGap to the left of the
  // document; the rest stacks outward (further left). The 2-col layout also
  // places one chat in the RIGHT margin, at docRight + marginGap (below).
  // Everything is laid out relative to the document edges — never relative to
  // the HUD position, which is a separate offset (the anchor shape).
  const leftContentW =
    variant === 'big-chat' ? leftW + gap + Math.round(chatW3 * 2)
    : variant === 'both-margins' ? leftW + gap + Math.round(chatW3 * 1.5)
    : leftW + gap + rightW

  let anchorX = docBounds.minLeft - marginGap - leftContentW
  let anchorY = docBounds.minTop - 1200

  // Push this (identity, device)'s whole layout into its own guaranteed-free
  // vertical lane so two owners' shapes can never overlap. dy bands owners
  // vertically by a lane index chosen to miss every other owner present in the
  // room (laneDy); dx is a cosmetic horizontal spread the HUD compensates. My
  // HUD view is unaffected — its camera follows my own shapes' bounds — so this
  // only separates the underlying canvas shapes, which is what keeps a foreign
  // layout from overlapping mine.
  const { dx } = layoutOffset(myId, myDevice)
  const dy = laneDy(editor, myId, myDevice)
  anchorX += dx
  anchorY += dy

  return {
    variant,
    myId,
    myDevice,
    anchorX,
    anchorY,
    docMaxRight: docBounds.maxRight,
    dx,
    gap,
    leftW,
    chatW3,
    marginGap,
    totalH,
    agentsH,
    searchH,
    rightChatH,
    docviewH,
    viewport: vp,
    makeSlotId,
    filters: [filter1, filter2, filter3, filter4],
  }
}

export function getDocumentPageBounds(editor: Editor): DocumentPageBounds | null {
  const currentPlaceBounds = getCurrentVisibleDocumentPlaceBounds(editor)
  if (currentPlaceBounds) return currentPlaceBounds

  const pageShapes = editor.getCurrentPageShapes().filter(isDocumentPageShape)
  return boundsForPageShapes(editor, pageShapes)
}

function boundsForPageShapes(editor: Editor, pageShapes: any[]): DocumentPageBounds | null {
  let minLeft = Infinity, minTop = Infinity, maxRight = -Infinity
  const pagesWithBounds: any[] = []
  for (const ps of pageShapes) {
    const b = editor.getShapePageBounds(ps.id)
    if (!b) continue
    pagesWithBounds.push(ps)
    if (b.x < minLeft) minLeft = b.x
    if (b.y < minTop) minTop = b.y
    if (b.x + b.w > maxRight) maxRight = b.x + b.w
  }
  if (pagesWithBounds.length === 0 || !isFinite(minLeft) || !isFinite(minTop) || !isFinite(maxRight)) return null
  return { pageShapes: pagesWithBounds, minLeft, minTop, maxRight }
}

function getCurrentVisibleDocumentPlaceBounds(editor: Editor): DocumentPageBounds | null {
  const viewport = editor.getViewportPageBounds()
  let best: { shape: any; area: number } | null = null
  for (const shape of editor.getCurrentPageShapes().filter(isCanvasPageShape)) {
    const bounds = editor.getShapePageBounds(shape.id)
    if (!bounds) continue
    const overlapW = Math.max(0, Math.min(bounds.x + bounds.w, viewport.x + viewport.w) - Math.max(bounds.x, viewport.x))
    const overlapH = Math.max(0, Math.min(bounds.y + bounds.h, viewport.y + viewport.h) - Math.max(bounds.y, viewport.y))
    const area = overlapW * overlapH
    if (area <= 0) continue
    if (!best || area > best.area) best = { shape, area }
  }
  if (!best?.shape?.meta?.temporaryMarkdownColumn) return null
  const bounds = editor.getShapePageBounds(best.shape.id)
  if (!bounds) return null
  return {
    pageShapes: [best.shape],
    minLeft: bounds.x,
    minTop: bounds.y,
    maxRight: bounds.x + bounds.w,
  }
}
