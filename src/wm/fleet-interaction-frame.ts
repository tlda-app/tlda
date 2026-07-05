import type { Editor, TLViewportId } from 'tldraw'
import { clientPointToPage } from './viewport-coordinates'

export interface FleetInteractionFrame {
  viewportId?: TLViewportId
}

export function fleetInteractionFrame(viewportId?: TLViewportId): FleetInteractionFrame {
  return { viewportId }
}

export function fleetPointerPagePoint(
  editor: Editor,
  frame: FleetInteractionFrame,
  point: { x: number; y: number },
) {
  return clientPointToPage(editor, point, frame.viewportId)
}

export function fleetPointerEventPagePoint(
  editor: Editor,
  frame: FleetInteractionFrame,
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
) {
  return fleetPointerPagePoint(editor, frame, { x: event.clientX, y: event.clientY })
}
