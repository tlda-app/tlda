import type { Editor } from 'tldraw'
import { getLayoutReadabilityTokens } from '../readabilityProfile'
import { isCanvasPageShape, isDocumentPageShape } from './document-pages'
import { CANONICAL_FLOW_LEAD, laneDy, layoutOffset } from './fleet-layout-geometry'
import { crossAxis, documentFlowAxis, type Axis } from './document-flow-axis'
import type { FleetLayoutPlanInput, FleetLayoutVariant } from './fleet-layout-plan'
import { defaultFleetLayoutChatFilters } from './fleet-layout-seeding'
import { currentVisibleViewportSize, singleChatViewportPanelSize } from './fleet-layout-sizing'

export type DocumentPageBounds = {
  pageShapes: any[]
  minLeft: number
  minTop: number
  maxRight: number
  /** Needed by the transposed layout: when pages flow across, the second margin
   *  is BELOW the document, the way it is to the right of a stacked one. */
  maxBottom: number
}

export type FleetLayoutViewportBounds = { x: number; y: number; w: number; h: number }

export function fleetLayoutPanelCount(variant: string): number {
  return variant === '2x2' ? 4 : variant === 'big-chat' || variant === 'single-chat' ? 1 : 2
}

export function buildFleetLayoutPlanInput({
  editor,
  agents,
  variant,
  myId,
  myDevice,
  docBounds,
  makeSlotId,
  viewport,
}: {
  editor: Editor
  agents: any[]
  variant: FleetLayoutVariant | string
  myId: string
  myDevice: string
  docBounds: DocumentPageBounds
  makeSlotId: (slot: string) => string
  viewport?: FleetLayoutViewportBounds
}): FleetLayoutPlanInput {
  const panelCount = fleetLayoutPanelCount(variant)
  const [filter1 = [], filter2 = [], filter3 = [], filter4 = []] = defaultFleetLayoutChatFilters({
    agents,
    humanId: myId,
    panelCount,
  })

  const vp = viewport ?? currentVisibleViewportSize() ?? editor.getViewportScreenBounds()
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
    variant === 'single-chat' ? singleChatViewportPanelSize(vp).w
    : variant === 'big-chat' ? leftW + gap + Math.round(chatW3 * 2)
    : variant === 'both-margins' ? leftW + gap + Math.round(chatW3 * 1.5)
    : leftW + gap + rightW

  // The layout lives in the margin the document leaves, which is the margin
  // ACROSS its flow: a document that runs down the canvas leaves room beside it,
  // one that runs across leaves room above. Its far edge sits marginGap before
  // the document's near edge; along the flow axis it simply aligns with the
  // document. Skip: "the default computation is based on the distance between
  // nearest lines — the margin for the document and the near edge for the
  // layout."
  //
  // One rule, stated on an axis. There is no paper case and no talk case here.
  const flowAxis = documentFlowAxis(editor, getDocumentPageBounds)
  const marginAxis = crossAxis(flowAxis)
  const contentAcross = marginAxis === 'x' ? leftContentW : totalH
  const docNear = marginAxis === 'x' ? docBounds.minLeft : docBounds.minTop
  const acrossOrigin = docNear - marginGap - contentAcross

  // Along the flow axis the layout just tracks the document's near edge. Note
  // this coordinate is not observable: the HUD pins the flow axis to a position
  // on screen, so whatever we choose here cancels out of what anyone sees. It
  // exists so the canvas shapes sit somewhere sane and so the lane arithmetic
  // below has a stable base — CANONICAL_FLOW_LEAD is that base, unchanged.
  const alongOrigin = (flowAxis === 'x' ? docBounds.minLeft : docBounds.minTop) - CANONICAL_FLOW_LEAD

  let anchorX = marginAxis === 'x' ? acrossOrigin : alongOrigin
  let anchorY = marginAxis === 'y' ? acrossOrigin : alongOrigin

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
    docMaxBottom: docBounds.maxBottom,
    flowAxis,
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
  let minLeft = Infinity, minTop = Infinity, maxRight = -Infinity, maxBottom = -Infinity
  const pagesWithBounds: any[] = []
  for (const ps of pageShapes) {
    const b = editor.getShapePageBounds(ps.id)
    if (!b) continue
    pagesWithBounds.push(ps)
    if (b.x < minLeft) minLeft = b.x
    if (b.y < minTop) minTop = b.y
    if (b.x + b.w > maxRight) maxRight = b.x + b.w
    if (b.y + b.h > maxBottom) maxBottom = b.y + b.h
  }
  if (pagesWithBounds.length === 0 || !isFinite(minLeft) || !isFinite(minTop) || !isFinite(maxRight)) return null
  return { pageShapes: pagesWithBounds, minLeft, minTop, maxRight, maxBottom }
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
    maxBottom: bounds.y + bounds.h,
  }
}

/** The axis this document's pages run along. See document-flow-axis.ts for the
 *  rule everything about HUD placement is stated in. */
export function documentPageFlowAxis(editor: Editor): Axis {
  return documentFlowAxis(editor, getDocumentPageBounds)
}
