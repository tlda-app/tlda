import type { FleetChatFilter } from './fleet-layout-seeding'
import { fleetPanelDefaultProps, type FleetPanelType } from './fleet-panel-registry'
import { getLayoutReadabilityTokens } from '../readabilityProfile'

export type FleetLayoutVariant = 'phone' | '3-col' | '2x2' | 'big-chat' | 'both-margins' | 'touch'

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
  phoneTarget: { pageX: number } | null
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
    viewport,
    phoneTarget,
    makeSlotId,
    filters: [filter1, filter2, filter3, filter4],
  } = input

  // Phone layout: three horizontal, screen-sized lanes.
  // Left lane: agents over inbox/filter surface.
  // Middle lane: chat.
  // Right lane: the document page itself.
  // The fleet lanes are TLDraw/HUD shapes placed immediately to the left of
  // the document page; PhoneHandTool snaps the main camera between these
  // three document-left screen offsets.
  if (variant === 'phone') {
    if (!phoneTarget) return { shapes: [], dispatchHudReset: false }

    const screenW = Math.round(viewport.w)
    const screenH = Math.round(viewport.h)
    const chatW = screenW
    const chatH = screenH
    const colW = screenW
    const phoneAgentsH = Math.max(160, getLayoutReadabilityTokens(viewport).agentsH)
    const phoneInboxH = Math.max(160, chatH - gap - phoneAgentsH)
    const chatX = phoneTarget.pageX - chatW + dx
    const colX = phoneTarget.pageX - chatW - colW + dx
    return {
      dispatchHudReset: true,
      shapes: [
        panelShape('fleet-agents', {
          id: makeSlotId('agents'),
          x: colX, y: anchorY,
          isLocked: true,
          props: { w: colW, h: phoneAgentsH },
        }, myId, myDevice),
        panelShape('fleet-inbox', {
          id: makeSlotId('inbox'),
          x: colX, y: anchorY + phoneAgentsH + gap,
          isLocked: true,
          props: { w: colW, h: phoneInboxH },
        }, myId, myDevice),
        panelShape('fleet-chat', {
          id: makeSlotId('chat-0'),
          x: chatX, y: anchorY,
          isLocked: true,
          props: { w: chatW, h: chatH, filter: filter1 },
        }, myId, myDevice),
      ],
    }
  }

  // Touch layout: a single container (inbox strip + nested chat), one column.
  // The container auto-creates its own fleet-chat child, so no other shapes.
  if (variant === 'touch') {
    const touchW = chatW3
    return {
      dispatchHudReset: false,
      shapes: [panelShape('fleet-touch-inbox', {
        id: makeSlotId('touch-inbox'),
        x: anchorX + leftW + gap, y: anchorY,
        isLocked: false,
        props: { w: touchW, h: totalH },
      }, myId, myDevice)],
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
