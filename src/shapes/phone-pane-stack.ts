import { createShapeId, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import { isFleetShapeForOwnerKey, isMyFleetShape } from './fleet-ownership'
import { isDocumentPageShape } from './document-pages'
import { fleetPanelDefaultProps } from './fleet-panel-registry'
import { dispatchFleetHudReset, markMainEditorHistoryStoppingPoint } from '../wm/editor-host-bridge'
export { PHONE_DOCUMENT_PANE_INDEX, PHONE_INBOX_PANE_INDEX, phonePaneX } from './phone-pane-geometry'
import { PHONE_DOCUMENT_PANE_INDEX, PHONE_INBOX_PANE_INDEX, phonePaneX } from './phone-pane-geometry'
// @ts-ignore — vanilla JS module
import { getDeviceId, getHumanId, isDeviceReady } from '../fleet/fleet-data.mjs'

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
    url?: string
  }
  meta?: {
    temporaryMarkdownColumn?: unknown
    phonePaneOwner?: { userId?: string; deviceId?: string }
    title?: string
  }
}

type PhonePaneShapeUpdate = {
  id: TLShapeId
  type: string
  x?: number
  y?: number
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

export type PhonePaneStackRefitResult =
  | { ok: true; updatedIds: string[]; currentIndex: number; maxIndex: number; docLeftPage: number }
  | { ok: false; reason: 'owner-missing' | 'document-missing' | 'viewport-missing' | 'phone-stack-missing' | 'not-phone-stack' }

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

export function getPrimaryPhoneDocumentLeft(editor: Editor): number | null {
  return primaryDocumentLeft(editor)
}

function isFullScreenPhonePane(editor: Editor, shape: PhonePaneCandidate): boolean {
  const { w: screenW, h: screenH } = viewportSize(editor)
  if (!screenW || !screenH) return false
  const w = shape.props?.w || 0
  const h = shape.props?.h || 0
  if (shape.type === 'html-page') {
    const z = editor.getCamera().z || 1
    return Math.abs(w * z - screenW) <= 2 && h * z >= screenH - 2
  }
  return Math.abs(w - screenW) <= 2 && Math.abs(h - screenH) <= 2
}

export function isPhonePinnedPaneShape(editor: Editor, shape: TLShape | PhonePaneCandidate): boolean {
  const pane = shape as PhonePaneCandidate
  if (pane.type === 'html-page' && isDeviceReady()) {
    const userId = getHumanId()
    const deviceId = getDeviceId()
    if (!isPhoneMarkdownPaneForOwner(pane, userId, deviceId)) return false
  } else if (!isMyFleetShape(pane) || pane.type !== 'fleet-chat') {
    return false
  }
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

export function phonePaneCameraXForIndex(editor: Editor, docLeftPage: number, paneIndex: number): number | null {
  if (paneIndex === PHONE_DOCUMENT_PANE_INDEX) return -docLeftPage
  const entry = getPhonePaneStack(editor).find(entry => entry.index === paneIndex)
  if (!entry || entry.kind === 'document' || !entry.shapeId) return null
  const bounds = editor.getShapePageBounds(entry.shapeId as TLShapeId)
  const x = bounds?.x ?? null
  return typeof x === 'number' && Number.isFinite(x) ? -x : null
}

function isFullScreenPinnedPaneForOwner(editor: Editor, shape: PhonePaneCandidate, userId: string, deviceId: string): boolean {
  return isPhonePinnedPaneForOwner(shape, userId, deviceId) &&
    isFullScreenPhonePane(editor, shape)
}

function isPhoneMarkdownPaneForOwner(shape: PhonePaneCandidate, userId: string, deviceId: string): boolean {
  return shape.type === 'html-page' &&
    shape.meta?.temporaryMarkdownColumn === true &&
    shape.meta?.phonePaneOwner?.userId === userId &&
    shape.meta?.phonePaneOwner?.deviceId === deviceId
}

function isTemporaryMarkdownPane(shape: PhonePaneCandidate): boolean {
  return shape.type === 'html-page' && shape.meta?.temporaryMarkdownColumn === true
}

function isPhonePinnedPaneForOwner(shape: PhonePaneCandidate, userId: string, deviceId: string): boolean {
  return (
    (isFleetShapeForOwnerKey(shape, userId, deviceId) && shape.type === 'fleet-chat') ||
    isPhoneMarkdownPaneForOwner(shape, userId, deviceId)
  )
}

function isPhoneStackPaneForOwner(shape: PhonePaneCandidate, userId: string, deviceId: string): boolean {
  return (isFleetShapeForOwnerKey(shape, userId, deviceId) &&
    (shape.type === 'fleet-inbox' || shape.type === 'fleet-chat')) ||
    isPhoneMarkdownPaneForOwner(shape, userId, deviceId)
}

function updatePhonePaneShape(editor: Editor, update: PhonePaneShapeUpdate) {
  editor.updateShape(update as never)
}

function resizedPhonePaneProps(
  pane: PhonePaneCandidate,
  screenW: number,
  screenH: number,
  userId: string,
  deviceId: string,
): Record<string, unknown> {
  if (pane.type === 'html-page') return { w: screenW, h: screenH, url: pane.props?.url || '' }
  return { ...(pane.props || {}), w: screenW, h: screenH, userId, deviceId }
}

function phonePaneY(editor: Editor, fallbackY: number): number {
  const viewport = editor.getViewportPageBounds()
  return Number.isFinite(viewport.y) ? viewport.y : fallbackY
}

function phoneMarkdownPaneSize(editor: Editor, screenW: number, screenH: number): { w: number; h: number } {
  const z = editor.getCamera().z || 1
  return { w: screenW / z, h: screenH / z }
}

function phonePinnedPaneX(
  editor: Editor,
  pane: PhonePaneCandidate,
  docLeftPage: number,
  paneIndex: number,
  screenW: number,
  dx: number,
): number {
  return pane.type === 'html-page'
    ? docLeftPage - paneIndex * phoneMarkdownPaneSize(editor, screenW, 1).w
    : phonePaneX(docLeftPage, paneIndex, screenW, dx)
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
  const markdownY = phonePaneY(editor, y)
  const shapes = editor.getCurrentPageShapes() as PhonePaneCandidate[]
  const oldMarkdownPaneIds = shapes
    .filter(isTemporaryMarkdownPane)
    .map(shape => shape.id)
    .filter((id): id is TLShapeId => typeof id === 'string')
  const pinned = shapes
    .filter(shape => isFullScreenPinnedPaneForOwner(editor, shape, userId, deviceId))
    .filter(shape => !oldMarkdownPaneIds.includes(shape.id as TLShapeId))
    .sort((a, b) => ((b.x || 0) - (a.x || 0)) || String(a.id).localeCompare(String(b.id)))
  const createdId = createShapeId()
  const markdownSize = phoneMarkdownPaneSize(editor, screenW, screenH)

  markMainEditorHistoryStoppingPoint(editor)
  editor.run(() => {
    if (oldMarkdownPaneIds.length > 0) editor.deleteShapes(oldMarkdownPaneIds)
    for (const pane of pinned) {
      if (!pane.id || !pane.type) continue
      if (pane.isLocked) {
        editor.updateShape({ id: pane.id as any, type: pane.type as any, isLocked: false } as any)
      }
      editor.updateShape({
        id: pane.id as any,
        type: pane.type as any,
        x: pane.type === 'html-page'
          ? docLeft - (PHONE_INBOX_PANE_INDEX + 2) * markdownSize.w
          : (pane.x || 0) - screenW,
        y: pane.type === 'html-page' ? markdownY : undefined,
        props: pane.type === 'html-page'
          ? { w: markdownSize.w, h: markdownSize.h, url: pane.props?.url || '' }
          : resizedPhonePaneProps(pane, screenW, screenH, userId, deviceId),
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

export function pushPhonePinnedMarkdownPane(
  editor: Editor,
  inboxShape: PhonePaneCandidate,
  url: string,
  title: string,
): PhonePinnedPanePushResult {
  const userId = inboxShape.props?.userId
  const deviceId = inboxShape.props?.deviceId
  if (!userId || !deviceId) return { ok: false, reason: 'owner-missing' }

  const { w: screenW, h: screenH } = viewportSize(editor)
  if (!screenW || !screenH) return { ok: false, reason: 'viewport-missing' }
  if (!isFullScreenPhonePane(editor, inboxShape)) return { ok: false, reason: 'inbox-not-fullscreen' }

  const docLeft = primaryDocumentLeft(editor)
  if (docLeft === null) return { ok: false, reason: 'document-missing' }

  const y = inboxShape.y || 0
  const markdownY = phonePaneY(editor, y)
  const shapes = editor.getCurrentPageShapes() as PhonePaneCandidate[]
  const oldMarkdownPaneIds = shapes
    .filter(isTemporaryMarkdownPane)
    .map(shape => shape.id)
    .filter((id): id is TLShapeId => typeof id === 'string')
  const pinned = shapes
    .filter(shape => isFullScreenPinnedPaneForOwner(editor, shape, userId, deviceId))
    .filter(shape => !oldMarkdownPaneIds.includes(shape.id as TLShapeId))
    .sort((a, b) => ((b.x || 0) - (a.x || 0)) || String(a.id).localeCompare(String(b.id)))
  const createdId = createShapeId()
  const markdownSize = phoneMarkdownPaneSize(editor, screenW, screenH)

  markMainEditorHistoryStoppingPoint(editor)
  editor.run(() => {
    if (oldMarkdownPaneIds.length > 0) editor.store.remove(oldMarkdownPaneIds)
    for (const pane of pinned) {
      if (!pane.id || !pane.type) continue
      if (pane.isLocked) {
        editor.updateShape({ id: pane.id as any, type: pane.type as any, isLocked: false } as any)
      }
      editor.updateShape({
        id: pane.id as any,
        type: pane.type as any,
        x: pane.type === 'html-page'
          ? docLeft - (PHONE_INBOX_PANE_INDEX + 2) * markdownSize.w
          : (pane.x || 0) - screenW,
        y: pane.type === 'html-page' ? markdownY : undefined,
        props: pane.type === 'html-page'
          ? { w: markdownSize.w, h: markdownSize.h, url: pane.props?.url || '' }
          : resizedPhonePaneProps(pane, screenW, screenH, userId, deviceId),
        isLocked: true,
      } as any)
    }
    editor.createShape({
      id: createdId,
      type: 'html-page' as any,
      x: docLeft - (PHONE_INBOX_PANE_INDEX + 1) * markdownSize.w,
      y: markdownY,
      isLocked: true,
      props: { w: markdownSize.w, h: markdownSize.h, url },
      meta: {
        temporaryMarkdownColumn: true,
        title,
        phonePaneOwner: { userId, deviceId },
        createdAt: Date.now(),
      },
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
  const userId = paneShape.props?.userId || paneShape.meta?.phonePaneOwner?.userId
  const deviceId = paneShape.props?.deviceId || paneShape.meta?.phonePaneOwner?.deviceId
  if (!userId || !deviceId) return { ok: false, reason: 'owner-missing' }

  const { w: screenW, h: screenH } = viewportSize(editor)
  if (!screenW || !screenH) return { ok: false, reason: 'viewport-missing' }

  const docLeft = primaryDocumentLeft(editor)
  if (docLeft === null) return { ok: false, reason: 'document-missing' }

  const shapes = editor.getCurrentPageShapes() as PhonePaneCandidate[]
  const inbox = shapes.find(shape =>
    isFleetShapeForOwnerKey(shape, userId, deviceId) &&
    shape.type === 'fleet-inbox'
  )
  const dx = (inbox?.x || 0) - phonePaneX(docLeft, PHONE_INBOX_PANE_INDEX, Math.round(inbox?.props?.w || screenW) || screenW, 0)

  const pinned = shapes
    .filter(shape => isFullScreenPinnedPaneForOwner(editor, shape, userId, deviceId))
    .sort((a, b) => ((b.x || 0) - (a.x || 0)) || String(a.id).localeCompare(String(b.id)))

  const targetPosition = pinned.findIndex(shape => String(shape.id) === String(paneShape.id))
  if (targetPosition < 0 || !paneShape.id || !paneShape.type) return { ok: false, reason: 'pane-not-pinned' }
  const targetId = paneShape.id as TLShapeId
  const targetType = paneShape.type

  const targetIndex = PHONE_INBOX_PANE_INDEX + 1 + targetPosition
  const shifted = pinned.slice(targetPosition + 1)
  const remainingPinnedCount = Math.max(0, pinned.length - 1)
  const maxIndex = PHONE_INBOX_PANE_INDEX + remainingPinnedCount
  const snapIndex = remainingPinnedCount === 0 ? PHONE_INBOX_PANE_INDEX : Math.min(targetIndex, maxIndex)

  markMainEditorHistoryStoppingPoint(editor)
  editor.run(() => {
    for (const [i, pane] of shifted.entries()) {
      if (!pane.id || !pane.type) continue
      const nextIndex = targetIndex + i
      if (pane.isLocked) {
        updatePhonePaneShape(editor, { id: pane.id as TLShapeId, type: pane.type, isLocked: false })
      }
      updatePhonePaneShape(editor, {
        id: pane.id as TLShapeId,
        type: pane.type,
        x: phonePinnedPaneX(editor, pane, docLeft, nextIndex, screenW, dx),
        y: pane.type === 'html-page' ? phonePaneY(editor, pane.y || 0) : undefined,
        props: resizedPhonePaneProps(pane, screenW, screenH, userId, deviceId),
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

export function isPhoneStackLayoutForOwner(editor: Editor, userId: string, deviceId: string): boolean {
  const shapes = editor.getCurrentPageShapes() as PhonePaneCandidate[]
  const owned = shapes.filter(shape => isFleetShapeForOwnerKey(shape, userId, deviceId))
  if (!owned.some(shape => shape.type === 'fleet-inbox')) return false
  return owned.every(shape => isPhoneStackPaneForOwner(shape, userId, deviceId))
}

export function refitPhonePaneStack(editor: Editor): PhonePaneStackRefitResult {
  const shapes = editor.getCurrentPageShapes() as PhonePaneCandidate[]
  const inbox = shapes.find(shape => isMyFleetShape(shape) && shape.type === 'fleet-inbox')
  const userId = inbox?.props?.userId
  const deviceId = inbox?.props?.deviceId
  if (!userId || !deviceId) return { ok: false, reason: 'owner-missing' }
  if (!inbox?.id || !inbox.type) return { ok: false, reason: 'phone-stack-missing' }
  if (!isPhoneStackLayoutForOwner(editor, userId, deviceId)) return { ok: false, reason: 'not-phone-stack' }

  const { w: screenW, h: screenH } = viewportSize(editor)
  if (!screenW || !screenH) return { ok: false, reason: 'viewport-missing' }

  const docLeft = primaryDocumentLeft(editor)
  if (docLeft === null) return { ok: false, reason: 'document-missing' }

  // Phone pane stops are defined relative to the visible document viewport.
  // Older persisted phone panes may still carry the desktop layout spread in
  // their x coordinate; refit is the repair point that pulls them back onto the
  // canonical phone stack instead of preserving that stale offset forever.
  const dx = 0
  const y = inbox.y || 0
  const markdownY = phonePaneY(editor, y)
  const pinned = shapes
    .filter(shape => isFullScreenPinnedPaneForOwner(editor, shape, userId, deviceId))
    .sort((a, b) => ((b.x || 0) - (a.x || 0)) || String(a.id).localeCompare(String(b.id)))
  const maxIndex = PHONE_INBOX_PANE_INDEX + pinned.length

  const paneUpdates: PhonePaneShapeUpdate[] = [
    {
      id: inbox.id as TLShapeId,
      type: inbox.type,
      x: phonePaneX(docLeft, PHONE_INBOX_PANE_INDEX, screenW, dx),
      y,
      props: { ...(inbox.props || {}), w: screenW, h: screenH, userId, deviceId },
      isLocked: true,
    },
  ]
  pinned.forEach((pane, i) => {
    if (!pane.id || !pane.type) return
    const paneIndex = PHONE_INBOX_PANE_INDEX + 1 + i
    paneUpdates.push({
      id: pane.id as TLShapeId,
      type: pane.type,
      x: phonePinnedPaneX(editor, pane, docLeft, paneIndex, screenW, dx),
      y: pane.type === 'html-page' ? markdownY : y,
      props: pane.type === 'html-page'
        ? { w: phoneMarkdownPaneSize(editor, screenW, screenH).w, h: phoneMarkdownPaneSize(editor, screenW, screenH).h, url: pane.props?.url || '' }
        : resizedPhonePaneProps(pane, screenW, screenH, userId, deviceId),
      isLocked: true,
    })
  })

  const currentIndex = Math.max(0, Math.min(maxIndex, Math.round((editor.getCamera().x + docLeft) * editor.getCamera().z / screenW)))
  editor.run(() => {
    for (const update of paneUpdates) {
      const shape = editor.getShape(update.id)
      if (shape?.isLocked) updatePhonePaneShape(editor, { id: update.id, type: update.type, isLocked: false })
      updatePhonePaneShape(editor, update)
    }
  }, { history: 'ignore' })
  dispatchFleetHudReset()

  return {
    ok: true,
    updatedIds: paneUpdates.map(update => String(update.id)),
    currentIndex,
    maxIndex,
    docLeftPage: docLeft,
  }
}
