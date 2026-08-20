import type { FleetChatFilter } from './fleet-layout-seeding'
import { fleetPanelDefaultProps, type FleetPanelType } from './fleet-panel-registry'
import { singleChatViewportPanelSize } from './fleet-layout-sizing'
import type { Axis } from './document-flow-axis'

export type FleetLayoutVariant = 'single-chat' | 'two-chat' | '3-col' | '2x2' | 'big-chat' | 'both-margins'

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
  docMaxBottom: number
  flowAxis: Axis
  dx: number
  gap: number
  leftW: number
  columnW: number
  innerColumnW: number
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
    docMaxBottom,
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
    makeSlotId,
    filters: [filter1, filter2, filter3, filter4],
  } = input

  if (variant === 'single-chat') {
    const size = singleChatViewportPanelSize(input.viewport)
    return {
      shapes: [
        panelShape('fleet-chat', {
          id: makeSlotId('chat-0'),
          x: anchorX,
          y: anchorY,
          isLocked: false,
          props: { w: size.w, h: size.h, filter: filter1 },
        }, myId, myDevice),
      ],
      dispatchHudReset: false,
    }
  }

  if (variant === 'two-chat') {
    // Skip: "I just want fucking two chats next to each other. Fucking sized
    // horizontally to, like, 80% screen width or whatever." — "I don't need a
    // fucking inbox. I don't need a fucking agents panel."
    //
    // So: two chats, nothing else. The width they share is set by the sizing
    // rule above, which measures the screen dimension on the pinned axis; here
    // they just split it.
    return {
      shapes: [
        panelShape('fleet-chat', {
          id: makeSlotId('chat-0'),
          x: anchorX, y: anchorY,
          isLocked: false,
          props: { w: columnW, h: totalH, filter: filter1 },
        }, myId, myDevice),
        panelShape('fleet-chat', {
          id: makeSlotId('chat-1'),
          x: anchorX + columnW + gap, y: anchorY,
          isLocked: false,
          props: { w: columnW, h: totalH, filter: filter2 },
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
    const chatWide = columnW + innerColumnW
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
    const gridChatW = columnW
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
        props: { w: innerColumnW, h: gridChatH, filter: filter2 },
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
        props: { w: innerColumnW, h: gridChatH, filter: filter4 },
      }, myId, myDevice),
    )
  } else if (variant === '3-col') {
    shapes.push(
      panelShape('fleet-chat', {
        id: makeSlotId('chat-0'),
        x: anchorX + leftW + gap, y: anchorY,
        isLocked: false,
        props: { w: columnW, h: totalH, filter: filter1 },
      }, myId, myDevice),
      panelShape('fleet-chat', {
        id: makeSlotId('chat-1'),
        x: anchorX + leftW + gap + columnW + gap, y: anchorY,
        isLocked: false,
        props: { w: innerColumnW, h: rightChatH, filter: filter2 },
      }, myId, myDevice),
      panelShape('fleet-docview', {
        id: makeSlotId('docview'),
        x: anchorX + leftW + gap + columnW + gap, y: anchorY + rightChatH + gap,
        isLocked: false,
        props: { w: innerColumnW, h: docviewH, mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '', sources: '["ref"]' },
      }, myId, myDevice),
    )
  } else {
    const innerWide = Math.round(columnW * 0.5) + innerColumnW
    const configuredWide = Math.round(columnW * 1.5)
    // A document has two margins across its flow, and this variant uses both:
    // the first group sits before the document's near edge (via the anchor), the
    // source editor after its far edge, each one marginGap away. Skip: "for these
    // sort of two margin layouts, you could do the same top and bottom." Which
    // pair of margins that is falls out of the flow axis rather than being
    // chosen — a document running down leaves left and right, one running across
    // leaves above and below.
    //
    // dx is zero for this variant: both groups are positioned against document
    // edges, which belong to the document coordinate frame. Owner separation is
    // carried by the layout's vertical lane instead.
    const docFar = flowAxis === 'x' ? docMaxBottom : docMaxRight
    const secondMarginStart = docFar + marginGap + (flowAxis === 'x' ? 0 : dx)
    const rightChatX = flowAxis === 'x' ? anchorX : secondMarginStart
    const rightChatY = flowAxis === 'x' ? secondMarginStart : anchorY

    shapes.push(
      panelShape('fleet-chat', {
        id: makeSlotId('chat-0'),
        x: anchorX + leftW + gap, y: anchorY,
        isLocked: false,
        props: { w: innerWide, h: rightChatH, filter: filter1 },
      }, myId, myDevice),
      panelShape('fleet-docview', {
        id: makeSlotId('docview'),
        x: anchorX + leftW + gap, y: anchorY + rightChatH + gap,
        isLocked: false,
        props: { w: innerWide, h: docviewH, mode: 'manual', label: '', page: 1, yTop: 0, yBottom: 300, title: '', sources: '["ref"]' },
      }, myId, myDevice),
      // Two-margin layout: the right margin holds the source editor sheet.
      panelShape('fleet-source-editor', {
        id: makeSlotId('source-editor'),
        x: rightChatX, y: rightChatY,
        isLocked: false,
        props: { w: configuredWide, h: totalH, file: '', line: 1, title: 'Source' },
      }, myId, myDevice),
    )
  }
  return { shapes, dispatchHudReset: false }
}
