import { createShapeId, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import { isFleetShapeForOwnerKey, isMyFleetShape } from './fleet-ownership'
import { isDocumentPageShape } from './document-pages'
import { fleetPanelDefaultProps } from './fleet-panel-registry'
import { dispatchFleetHudReset, markMainEditorHistoryStoppingPoint } from '../wm/editor-host-bridge'

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
  y?: number
  isLocked?: boolean
  props?: {
    w?: number
    h?: number
    userId?: string
    deviceId?: string
    filter?: FleetFilter
  }
}

type PhonePaneShapeUpdate = {
  id: TLShapeId
  type: string
  x?: number
  props?: Record<string, unknown>
  isLocked?: boolean
}

export type FleetFilter = [string, string][][]

export type PhonePinnedPanePushResult =
  | { ok: true; createdId: string; shiftedIds: string[]; newIndex: number; maxIndex: number; docLeftPage: number }
  | { ok: false; reason: 'owner-missing' | 'document-missing' | 'viewport-missing' | 'inbox-not-fullscreen' }

export type PhonePinnedPaneDeleteResult =
  | { ok: true; deletedId: string; shiftedIds: string[]; targetIndex: number; maxIndex: number; docLeftPage: number }
  | { ok: false; reason: 'owner-missing' | 'document-missing' | 'viewport-missing' | 'pane-not-pinned' }

function viewportSize(editor: Editor): { w: number; h: number } {
  const vp = editor.getViewportScreenBounds()
  return { w: Math.round(vp.w || 0), h: Math.round(vp.h || 0) }
}

function primaryDocumentLeft(editor: Editor): number | null {
  const pages = editor.getCurrentPageShapes().filter(isDocumentPageShape)
  if (pages.length === 0) return null
  const viewport = editor.getViewportPageBounds()
  const midY = viewport.minY + viewport.height / 2
  let best: { x: number; d: number } | null = null
  for (const page of pages) {
    const bounds = editor.getShapePageBounds(page.id)
    if (!bounds) continue
    const d = Math.abs((bounds.y + bounds.h / 2) - midY)
    if (!best || d < best.d) best = { x: bounds.x, d }
  }
  return best?.x ?? null
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

function isFullScreenPinnedPaneForOwner(editor: Editor, shape: PhonePaneCandidate, userId: string, deviceId: string): boolean {
  return isFleetShapeForOwnerKey(shape, userId, deviceId) &&
    shape.type === 'fleet-chat' &&
    isFullScreenPhonePane(editor, shape)
}

function updatePhonePaneShape(editor: Editor, update: PhonePaneShapeUpdate) {
  editor.updateShape(update as never)
}

export function pushPhonePinnedChatPane(editor: Editor, inboxShape: PhonePaneCandidate, filter: FleetFilter): PhonePinnedPanePushResult {
  const userId = inboxShape.props?.userId
  const deviceId = inboxShape.props?.deviceId
  if (!userId || !deviceId) return { ok: false, reason: 'owner-missing' }

  const { w: screenW, h: screenH } = viewportSize(editor)
  if (!screenW || !screenH) return { ok: false, reason: 'viewport-missing' }
  if (!isFullScreenPhonePane(editor, inboxShape)) return { ok: false, reason: 'inbox-not-fullscreen' }

  const docLeft = primaryDocumentLeft(editor)
  if (docLeft === null) return { ok: false, reason: 'document-missing' }

  const dx = (inboxShape.x || 0) - phonePaneX(docLeft, PHONE_INBOX_PANE_INDEX, screenW, 0)
  const topPaneX = phonePaneX(docLeft, PHONE_INBOX_PANE_INDEX + 1, screenW, dx)
  const y = inboxShape.y || 0
  const pinned = (editor.getCurrentPageShapes() as PhonePaneCandidate[])
    .filter(shape => isFullScreenPinnedPaneForOwner(editor, shape, userId, deviceId))
    .sort((a, b) => ((b.x || 0) - (a.x || 0)) || String(a.id).localeCompare(String(b.id)))
  const createdId = createShapeId()

  markMainEditorHistoryStoppingPoint(editor)
  editor.run(() => {
    for (const pane of pinned) {
      if (!pane.id || !pane.type) continue
      if (pane.isLocked) {
        editor.updateShape({ id: pane.id as any, type: pane.type as any, isLocked: false } as any)
      }
      editor.updateShape({
        id: pane.id as any,
        type: pane.type as any,
        x: (pane.x || 0) - screenW,
        props: { ...(pane.props || {}), w: screenW, h: screenH, userId, deviceId },
        isLocked: true,
      } as any)
    }
    editor.createShape({
      id: createdId,
      type: 'fleet-chat' as any,
      x: topPaneX,
      y,
      isLocked: true,
      props: { ...fleetPanelDefaultProps('fleet-chat'), w: screenW, h: screenH, filter, userId, deviceId },
    } as any)
  })
  dispatchFleetHudReset()

  return {
    ok: true,
    createdId: createdId as unknown as string,
    shiftedIds: pinned.map(pane => String(pane.id)).filter(Boolean),
    newIndex: PHONE_INBOX_PANE_INDEX + 1,
    maxIndex: PHONE_INBOX_PANE_INDEX + 1 + pinned.length,
    docLeftPage: docLeft,
  }
}

export function deletePhonePinnedChatPane(editor: Editor, paneShape: PhonePaneCandidate): PhonePinnedPaneDeleteResult {
  const userId = paneShape.props?.userId
  const deviceId = paneShape.props?.deviceId
  if (!userId || !deviceId) return { ok: false, reason: 'owner-missing' }

  const { w: screenW, h: screenH } = viewportSize(editor)
  if (!screenW || !screenH) return { ok: false, reason: 'viewport-missing' }

  const docLeft = primaryDocumentLeft(editor)
  if (docLeft === null) return { ok: false, reason: 'document-missing' }

  const pinned = (editor.getCurrentPageShapes() as PhonePaneCandidate[])
    .filter(shape => isFullScreenPinnedPaneForOwner(editor, shape, userId, deviceId))
    .sort((a, b) => ((b.x || 0) - (a.x || 0)) || String(a.id).localeCompare(String(b.id)))

  const targetPosition = pinned.findIndex(shape => String(shape.id) === String(paneShape.id))
  if (targetPosition < 0 || !paneShape.id || paneShape.type !== 'fleet-chat') return { ok: false, reason: 'pane-not-pinned' }
  const targetId = paneShape.id as TLShapeId
  const targetType = paneShape.type

  const targetIndex = PHONE_INBOX_PANE_INDEX + 1 + targetPosition
  const shifted = pinned.slice(targetPosition + 1)
  const remainingPinnedCount = Math.max(0, pinned.length - 1)
  const maxIndex = PHONE_INBOX_PANE_INDEX + remainingPinnedCount
  const snapIndex = remainingPinnedCount === 0 ? PHONE_INBOX_PANE_INDEX : Math.min(targetIndex, maxIndex)

  markMainEditorHistoryStoppingPoint(editor)
  editor.run(() => {
    for (const pane of shifted) {
      if (!pane.id || !pane.type) continue
      if (pane.isLocked) {
        updatePhonePaneShape(editor, { id: pane.id as TLShapeId, type: pane.type, isLocked: false })
      }
      updatePhonePaneShape(editor, {
        id: pane.id as TLShapeId,
        type: pane.type,
        x: (pane.x || 0) + screenW,
        props: { ...(pane.props || {}), w: screenW, h: screenH, userId, deviceId },
        isLocked: true,
      })
    }
    if (paneShape.isLocked) {
      updatePhonePaneShape(editor, { id: targetId, type: targetType, isLocked: false })
    }
    editor.deleteShapes([targetId])
  })
  dispatchFleetHudReset()

  return {
    ok: true,
    deletedId: String(targetId),
    shiftedIds: shifted.map(pane => String(pane.id)).filter(Boolean),
    targetIndex: snapIndex,
    maxIndex,
    docLeftPage: docLeft,
  }
}

export function isPhoneLayoutInboxShapeForOwner(editor: Editor, shape: unknown, userId: string, deviceId: string): boolean {
  const pane = shape as PhonePaneCandidate
  return isFleetShapeForOwnerKey(pane, userId, deviceId) &&
    pane.type === 'fleet-inbox' &&
    isFullScreenPhonePane(editor, pane)
}
