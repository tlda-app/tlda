import type { FleetChatFilter } from './fleet-layout-seeding'
import { fleetPanelDefaultProps, type FleetPanelType } from './fleet-panel-registry'

export type FleetLayoutVariant = 'single-chat' | '3-col' | '2x2' | 'big-chat' | 'both-margins'

export type FleetLayoutShapePlan = {
  id: string
  type: any
  x: number
  y: number
  isLocked: boolean
  props: Record<string, any>
}

export type FleetLayoutPlan = {
  shapes: FleetLayoutShapePlan[]
  dispatchHudReset: boolean
}

export type FleetLayoutPlanInput = {
  variant: FleetLayoutVariant | string
  myId: string
  myDevice: string
  anchorX: number
  anchorY: number
  docMaxRight: number
  dx: number
  gap: number
  leftW: number
  chatW3: number
  marginGap: number
  totalH: number
  agentsH: number
  searchH: number
  rightChatH: number
  docviewH: number
  viewport: { w: number; h: number }
  makeSlotId: (slot: string) => string
  filters: [
    FleetChatFilter,
    FleetChatFilter,
    FleetChatFilter,
    FleetChatFilter,
  ]
}

function panelShape(
  type: FleetPanelType,
  input: Omit<FleetLayoutShapePlan, 'type' | 'props'> & { props?: Record<string, any> },
  myId: string,
  myDevice: string,
): FleetLayoutShapePlan {
  return {
    ...input,
    type: type as any,
    props: { ...fleetPanelDefaultProps(type), ...(input.props ?? {}), userId: myId, deviceId: myDevice },
  }
}

export function planFleetLayoutShapes(input: FleetLayoutPlanInput): FleetLayoutPlan {
  const {
    variant,
    myId,
    myDevice,
    anchorX,
    anchorY,
    docMaxRight,
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
    makeSlotId,
    filters: [filter1, filter2, filter3, filter4],
  } = input

  if (variant === 'single-chat') {
    return {
      shapes: [
        panelShape('fleet-chat', {
          id: makeSlotId('chat-0'),
          x: anchorX,
          y: anchorY,
          isLocked: false,
          props: { w: input.viewport.w, h: input.viewport.h, filter: filter1 },
        }, myId, myDevice),
      ],
      dispatchHudReset: false,
    }
  }

  const shapes: FleetLayoutShapePlan[] = [
    panelShape('fleet-inbox', {
      id: makeSlotId('inbox'),
      x: anchorX - leftW - gap, y: anchorY,
      isLocked: false,
      props: { w: leftW, h: agentsH + gap + searchH },
    }, myId, myDevice),
    panelShape('fleet-agents', {
      id: makeSlotId('agents'),
      x: anchorX, y: anchorY,
      isLocked: false,
      props: { w: leftW, h: agentsH },
    }, myId, myDevice),
    panelShape('fleet-search', {
      id: makeSlotId('search'),
      x: anchorX, y: anchorY + agentsH + gap,
      isLocked: false,
      props: { w: leftW, h: searchH },
    }, myId, myDevice),
  ]
  if (variant === 'big-chat') {
    // Big-chat layout: half chat over half source editor.
    const chatWide = Math.round(chatW3 * 2)
    const wideChatH = Math.round((totalH - gap) / 2)
    const wideEditorH = totalH - gap - wideChatH
    shapes.push(
      panelShape('fleet-chat', {
        id: makeSlotId('chat-0'),
        x: anchorX + leftW + gap, y: anchorY,
        isLocked: false,
        props: { w: chatWide, h: wideChatH, filter: filter1 },
      }, myId, myDevice),
      panelShape('fleet-source-editor', {
        id: makeSlotId('source-editor'),
        x: anchorX + leftW + gap, y: anchorY + wideChatH + gap,
        isLocked: false,
        props: { w: chatWide, h: wideEditorH, file: '', line: 1, title: 'Source' },
      }, myId, myDevice),
    )
  } else if (variant === '2x2') {
    // 2x2 layout: four chats in a square (no document viewer).
    const gridChatW = chatW3
    const gridChatH = Math.round((totalH - gap) / 2)
    shapes.push(
      panelShape('fleet-chat', {
        id: makeSlotId('chat-0'),
        x: anchorX + leftW + gap, y: anchorY,
        isLocked: false,
        props: { w: gridChatW, h: gridChatH, filter: filter1 },
      }, myId, myDevice),
      panelShape('fleet-chat', {
        id: makeSlotId('chat-1'),
        x: anchorX + leftW + gap + gridChatW + gap, y: anchorY,
        isLocked: false,
        props: { w: gridChatW, h: gridChatH, filter: filter2 },
      }, myId, myDevice),
      panelShape('fleet-chat', {
        id: makeSlotId('chat-2'),
        x: anchorX + leftW + gap, y: anchorY + gridChatH + gap,
        isLocked: false,
        props: { w: gridChatW, h: gridChatH, filter: filter3 },
      }, myId, myDevice),
      panelShape('fleet-chat', {
        id: makeSlotId('chat-3'),
        x: anchorX + leftW + gap + gridChatW + gap, y: anchorY + gridChatH + gap,
        isLocked: false,
        props: { w: gridChatW, h: gridChatH, filter: filter4 },
      }, myId, myDevice),
    )
  } else if (variant === '3-col') {
    shapes.push(
      panelShape('fleet-chat', {
        id: makeSlotId('chat-0'),
        x: anchorX + leftW + gap, y: anchorY,
        isLocked: false,
        props: { w: chatW3, h: totalH, filter: filter1 },
      }, myId, myDevice),
      panelShape('fleet-chat', {
        id: makeSlotId('chat-1'),
        x: anchorX + leftW + gap + chatW3 + gap, y: anchorY,
        isLocked: false,
        props: { w: chatW3, h: rightChatH, filter: filter2 },
      }, myId, myDevice),
      panelShape('fleet-docview', {
        id: makeSlotId('docview'),
        x: anchorX + leftW + gap + chatW3 + gap, y: anchorY + rightChatH + gap,
        isLocked: false,
        props: { w: chatW3, h: docviewH, mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '' },
      }, myId, myDevice),
    )
  } else {
    const chatWide = Math.round(chatW3 * 1.5)
    // Left group's right edge already sits marginGap left of the document
    // (via anchorX). The right-margin chat's left edge sits marginGap right
    // of the document — both in page coords, so the HUD maps them 1:1. Add the
    // same dx so the WHOLE layout translates as one rigid unit (the HUD then
    // compensates that dx, rendering every shape in its canonical position).
    const rightChatX = docMaxRight + marginGap + dx

    shapes.push(
      panelShape('fleet-chat', {
        id: makeSlotId('chat-0'),
        x: anchorX + leftW + gap, y: anchorY,
        isLocked: false,
        props: { w: chatWide, h: rightChatH, filter: filter1 },
      }, myId, myDevice),
      panelShape('fleet-docview', {
        id: makeSlotId('docview'),
        x: anchorX + leftW + gap, y: anchorY + rightChatH + gap,
        isLocked: false,
        props: { w: chatWide, h: docviewH, mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '' },
      }, myId, myDevice),
      // Two-margin layout: the right margin holds the source editor sheet.
      panelShape('fleet-source-editor', {
        id: makeSlotId('source-editor'),
        x: rightChatX, y: anchorY,
        isLocked: false,
        props: { w: chatWide, h: totalH, file: '', line: 1, title: 'Source' },
      }, myId, myDevice),
    )
  }
  return { shapes, dispatchHudReset: false }
}
