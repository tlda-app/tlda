import type { Editor, TLShape } from 'tldraw'
import { isFleetShapeForOwnerKey, isMyFleetShape } from './fleet-ownership'

export const PHONE_DOCUMENT_PANE_INDEX = 0
export const PHONE_INBOX_PANE_INDEX = 1

export type PhonePaneStackEntry =
  | { kind: 'document'; index: 0 }
  | { kind: 'inbox'; index: 1; shapeId?: string }
  | { kind: 'pinned'; index: number; shapeId: string; type: string }

type PhonePaneCandidate = {
  id?: unknown
  type?: string
  x?: number
  props?: {
    w?: number
    h?: number
  }
}

function viewportSize(editor: Editor): { w: number; h: number } {
  const vp = editor.getViewportScreenBounds()
  return { w: Math.round(vp.w || 0), h: Math.round(vp.h || 0) }
}

export function phonePaneX(docLeftPage: number, paneIndex: number, screenW: number, dx: number): number {
  return docLeftPage - paneIndex * screenW + dx
}

function isFullScreenPhonePane(editor: Editor, shape: PhonePaneCandidate): boolean {
  const { w: screenW, h: screenH } = viewportSize(editor)
  if (!screenW || !screenH) return false
  const w = shape.props?.w || 0
  const h = shape.props?.h || 0
  return Math.abs(w - screenW) <= 2 && Math.abs(h - screenH) <= 2
}

export function isPhonePinnedPaneShape(editor: Editor, shape: TLShape | PhonePaneCandidate): boolean {
  const pane = shape as PhonePaneCandidate
  if (!isMyFleetShape(pane)) return false
  if (pane.type !== 'fleet-chat') return false
  return isFullScreenPhonePane(editor, pane)
}

export function getPhonePaneStack(editor: Editor): PhonePaneStackEntry[] {
  const entries: PhonePaneStackEntry[] = [{ kind: 'document', index: PHONE_DOCUMENT_PANE_INDEX }]
  const shapes = editor.getCurrentPageShapes() as PhonePaneCandidate[]
  const inbox = shapes.find(shape => isMyFleetShape(shape) && shape.type === 'fleet-inbox' && isFullScreenPhonePane(editor, shape))
  entries.push({ kind: 'inbox', index: PHONE_INBOX_PANE_INDEX, shapeId: inbox?.id as string | undefined })

  const pinned = shapes
    .filter(shape => isPhonePinnedPaneShape(editor, shape))
    .sort((a, b) => ((b.x || 0) - (a.x || 0)) || String(a.id).localeCompare(String(b.id)))

  pinned.forEach((shape, i) => {
    entries.push({
      kind: 'pinned',
      index: PHONE_INBOX_PANE_INDEX + 1 + i,
      shapeId: shape.id as string,
      type: shape.type as string,
    })
  })
  return entries
}

export function phonePaneStackMaxIndex(editor: Editor): number {
  return getPhonePaneStack(editor).length - 1
}

export function isPhoneLayoutInboxShapeForOwner(editor: Editor, shape: unknown, userId: string, deviceId: string): boolean {
  const pane = shape as PhonePaneCandidate
  return isFleetShapeForOwnerKey(pane, userId, deviceId) &&
    pane.type === 'fleet-inbox' &&
    isFullScreenPhonePane(editor, pane)
}
