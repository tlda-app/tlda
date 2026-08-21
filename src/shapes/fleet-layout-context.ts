import type { Editor } from 'tldraw'
import { getLayoutReadabilityTokens } from '../readabilityProfile'
import { isCanvasPageShape, isDocumentPageShape } from './document-pages'
import { CANONICAL_FLOW_LEAD, laneDy, layoutOffset } from './fleet-layout-geometry'
import { crossAxis, documentFlowAxis, type Axis } from './document-flow-axis'
import type { FleetLayoutPlanInput, FleetLayoutVariant } from './fleet-layout-plan'
import { defaultFleetLayoutChatFilters, type FleetChatFilter } from './fleet-layout-seeding'
import { adaptiveInnerColumnWidth, currentVisibleViewportSize, projectedDocumentSpan, singleChatViewportPanelSize } from './fleet-layout-sizing'
import { fleetLayoutDx } from './fleet-layout-offset-policy'

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

/** Width of the content group a variant lays out, excluding the rail that hangs
 *  outside it. One place, so the fit-to-viewport scale and the placement agree. */
function variantContentW(
  variant: FleetLayoutVariant | string,
  vp: { w: number; h: number },
  leftW: number,
  columnW: number,
  innerColumnW: number,
  gap: number,
): number {
  if (variant === 'single-chat') return singleChatViewportPanelSize(vp).w
  if (variant === 'two-chat') return columnW * 2 + gap
  if (variant === 'big-chat') return leftW + gap + columnW + innerColumnW
  if (variant === 'both-margins') return leftW + gap + Math.round(columnW * 0.5) + innerColumnW
  return leftW + gap + columnW + gap + innerColumnW
}

export function fleetLayoutPanelCount(variant: string): number {
  return variant === '2x2' ? 4 : variant === 'big-chat' || variant === 'single-chat' ? 1 : 2
}

export function buildFleetLayoutPlanInput({
  editor,
  agents,
  variant,
  myId,
  myName,
  myDevice,
  docBounds,
  events,
  existingChatFilters,
  makeSlotId,
  viewport,
}: {
  editor: Editor
  agents: any[]
  variant: FleetLayoutVariant | string
  myId: string
  myName?: string
  myDevice: string
  docBounds: DocumentPageBounds
  events?: any[]
  existingChatFilters?: FleetChatFilter[]
  makeSlotId: (slot: string) => string
  viewport?: FleetLayoutViewportBounds
}): FleetLayoutPlanInput {
  const panelCount = fleetLayoutPanelCount(variant)
  const [filter1 = [], filter2 = [], filter3 = [], filter4 = []] = defaultFleetLayoutChatFilters({
    agents,
    events,
    humanId: myId,
    humanName: myName,
    panelCount,
    existingFilters: existingChatFilters,
  })

  const vp = viewport ?? currentVisibleViewportSize() ?? editor.getViewportScreenBounds()
  const layoutTokens = getLayoutReadabilityTokens(vp)
  const gap = layoutTokens.gap
  const marginGap = layoutTokens.marginGap

  const flowAxis = documentFlowAxis(editor, getDocumentPageBounds)
  const marginAxis = crossAxis(flowAxis)

  // A layout is sized against the screen dimension on the axis it is PINNED to,
  // because that is the one it has to live within — the other axis it shares
  // with the document and can extend along. Skip: "you're not sizing the screen
  // width, right? Normally we size the screen height. But when we are at fixed
  // horizontal position, we need to size to screen width."
  //
  // The HUD is pinned along the flow axis, so a document that runs down the page
  // is sized to screen height, exactly as before — every column width still comes
  // off totalH and nothing about a paper changes. A document that runs across is
  // pinned horizontally, so it is sized to screen width instead. Its columns had
  // been derived from height and their sum never checked against the screen,
  // which is how 1430 of layout ended up on a 1194 screen. Skip: "right now, have
  // shit off my fucking screen."
  const layoutSpanFrac = 0.8
  // two-chat has no rail hanging outside it, so its span is just its content.
  const railSpan = variant === 'two-chat' ? 0 : layoutTokens.leftW + gap
  const naturalSpan = railSpan + variantContentW(
    variant,
    vp,
    layoutTokens.leftW,
    layoutTokens.columnW,
    layoutTokens.columnW,
    gap,
  )
  // Deriving column widths from viewport HEIGHT is deliberate, not a defect.
  // Skip, 2026-08-18: "I don't really want to change the panel widths derived
  // from viewport height thing. That's a natural thing to do because you can pan
  // across but you can't move up and down. Right? That's how the HUD works."
  // Height is the dimension that is actually fixed, so it is the sane one to
  // derive from. Two of us read this as the bug; it is the design.
  //
  // The document and the layout do compete for one screen width — the panels sit
  // in the document's margin at 1:1 screen px — but the lever for that is the
  // ASPECT, not a scale applied here. Narrower columns per unit of height give
  // the document the difference and leave this mechanism alone. See
  // readabilityDefaults.ts. Skip: "Changing the aspect ratio is something you can
  // for sure do."
  //
  // So this stays 1 for a down-flowing paper, as it always was.
  const columnScale = flowAxis === 'x' || variant === 'two-chat'
    ? (vp.w * layoutSpanFrac) / Math.max(1, naturalSpan)
    : 1
  const leftW = Math.round(layoutTokens.leftW * columnScale)
  const columnW = Math.round(layoutTokens.columnW * columnScale)
  const columnMinW = Math.round(layoutTokens.columnMinW * columnScale)
  const innerColumnW = flowAxis === 'y'
    ? adaptiveInnerColumnWidth({
        viewportWidth: vp.w,
        documentWidth: projectedDocumentSpan(point => editor.pageToScreen(point), docBounds, marginAxis),
        marginGap,
        preferredWidth: columnW,
        minimumWidth: columnMinW,
      })
    : columnW
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
  const leftContentW = variantContentW(variant, vp, leftW, columnW, innerColumnW, gap)

  // The layout lives in the margin the document leaves, which is the margin
  // ACROSS its flow: a document that runs down the canvas leaves room beside it,
  // one that runs across leaves room above. Its far edge sits marginGap before
  // the document's near edge; along the flow axis it simply aligns with the
  // document. Skip: "the default computation is based on the distance between
  // nearest lines — the margin for the document and the near edge for the
  // layout."
  //
  // One rule, stated on an axis. There is no paper case and no talk case here.
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
  const { dx: ownerDx } = layoutOffset(myId, myDevice)
  // A two-margin layout is positioned relative to both document edges, so its
  // page-space X coordinates must stay in the document's coordinate frame.
  // Other owners are already kept disjoint by laneDy on Y.
  const dx = fleetLayoutDx(variant, ownerDx)
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
    columnW,
    innerColumnW,
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
