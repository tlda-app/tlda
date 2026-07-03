import type { Editor } from 'tldraw'
import { getPref } from '../preferences'
import { isDocumentPageShape } from './document-pages'
import { laneDy, layoutOffset } from './fleet-layout-geometry'
import type { FleetLayoutPlanInput, FleetLayoutVariant } from './fleet-layout-plan'
import { defaultFleetLayoutChatFilters, type FleetChatFilter } from './fleet-layout-seeding'

export type DocumentPageBounds = {
  pageShapes: any[]
  minLeft: number
  minTop: number
  maxRight: number
}

export type PhoneLayoutTarget = { x: number; y: number; w: number; h: number; pageX: number }

export function fleetLayoutPanelCount(variant: string): number {
  return variant === '2x2' ? 4 : (variant === 'big-chat' || variant === 'phone') ? 1 : 2
}

export function buildFleetLayoutPlanInput({
  editor,
  agents,
  variant,
  myId,
  myDevice,
  docBounds,
  phoneTarget,
  existingChatFilters,
  makeSlotId,
}: {
  editor: Editor
  agents: any[]
  variant: FleetLayoutVariant | string
  myId: string
  myDevice: string
  docBounds: DocumentPageBounds
  phoneTarget: PhoneLayoutTarget | null
  existingChatFilters: Array<FleetChatFilter | undefined>
  makeSlotId: (slot: string) => string
}): FleetLayoutPlanInput {
  const panelCount = fleetLayoutPanelCount(variant)
  const [filter1 = [], filter2 = [], filter3 = [], filter4 = []] = defaultFleetLayoutChatFilters({
    agents,
    humanId: myId,
    existingChatFilters,
    panelCount,
  })

  const leftW = getPref('layout-rail-width')
  const gap = 10
  const chatW3 = getPref('layout-chat-width')
  const marginGap = getPref('layout-margin-gap')
  const rightW = chatW3 * 2 + gap
  const vp = editor.getViewportScreenBounds()
  // HUD renders fleet shapes via a z=1 camera (see FleetHUD.tsx), so page units
  // map 1:1 to screen px — size off the raw viewport, not the main-camera zoom.
  const totalH = Math.round(vp.h * getPref('layout-height-frac'))
  const agentsH = 330
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
    phoneTarget,
    makeSlotId,
    filters: [filter1, filter2, filter3, filter4],
  }
}

export function getDocumentPageBounds(editor: Editor): DocumentPageBounds | null {
  const pageShapes = editor.getCurrentPageShapes().filter(isDocumentPageShape)
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

export function getPhoneLayoutTarget(
  editor: Editor,
  pageShapes: any[],
  vp: ReturnType<Editor['getViewportScreenBounds']>,
): PhoneLayoutTarget | null {
  let target: PhoneLayoutTarget | null = null
  let bestArea = -1
  const sortedPages = [...pageShapes].sort((a: any, b: any) => (a.y ?? 0) - (b.y ?? 0))
  for (const ps of sortedPages) {
    const pb = editor.getShapePageBounds(ps.id)
    if (!pb) continue
    const tl = editor.pageToScreen({ x: pb.x, y: pb.y })
    const br = editor.pageToScreen({ x: pb.x + pb.w, y: pb.y + pb.h })
    const pageRect = {
      x: Math.min(tl.x, br.x),
      y: Math.min(tl.y, br.y),
      w: Math.abs(br.x - tl.x),
      h: Math.abs(br.y - tl.y),
      pageX: pb.x,
    }
    const clipped = {
      x: Math.max(pageRect.x, vp.x),
      y: Math.max(pageRect.y, vp.y),
      w: Math.max(0, Math.min(pageRect.x + pageRect.w, vp.x + vp.w) - Math.max(pageRect.x, vp.x)),
      h: Math.max(0, Math.min(pageRect.y + pageRect.h, vp.y + vp.h) - Math.max(pageRect.y, vp.y)),
    }
    const area = clipped.w * clipped.h
    if (area > bestArea) {
      bestArea = area
      target = pageRect
    }
  }
  return target
}
