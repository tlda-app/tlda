import type { Editor, TLShapeId } from 'tldraw'
import {
  FLEET_PILL_LEGACY_GRACE_MS,
  FLEET_PILL_STALE_MS,
  getActiveFleetPillIds,
  isFleetPillActive,
  markFleetPillInactive,
  shouldReclaimFleetPill,
} from './fleet-pill-policy'

type Pill = { id: TLShapeId; type: string; props?: { userId?: string; deviceId?: string; createdAt?: number; ephemeral?: boolean } }
type Options = {
  getIdentity: () => { userId: string; deviceId: string }
  now?: () => number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  windowTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  documentTarget?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'hidden'>
}
const installedEditors = new WeakSet<Editor>()

/** The scheduler and terminal authority for transient pill records in one editor. */
export function installFleetPillReclaimerWithIdentity(editor: Editor, options: Options): () => void {
  if (installedEditors.has(editor)) return () => {}
  installedEditors.add(editor)
  const now = options.now || Date.now
  const setTimer = options.setTimer || setTimeout
  const clearTimer = options.clearTimer || clearTimeout
  const windowTarget = options.windowTarget || window
  const documentTarget = options.documentTarget || document
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let disposed = false
  const cancelTimer = (id: string) => {
    const timer = timers.get(id)
    if (timer) clearTimer(timer)
    timers.delete(id)
  }
  const deleteIfEligible = (id: TLShapeId) => {
    cancelTimer(String(id))
    if (disposed) return
    const shape = editor.getShape(id) as Pill | undefined
    if (shape && shouldReclaimFleetPill(shape, now(), options.getIdentity())) editor.run(() => {
      if (editor.getShape(id)) editor.deleteShapes([id])
    }, { history: 'ignore' })
  }
  const schedule = (shape: Pill) => {
    if (shape.type !== 'fleet-pill' || isFleetPillActive(String(shape.id))) return
    cancelTimer(String(shape.id))
    const props = shape.props || {}
    const legacy = !props.userId && !props.deviceId && props.createdAt == null && props.ephemeral == null
    const delay = legacy ? FLEET_PILL_LEGACY_GRACE_MS : Math.max(0, FLEET_PILL_STALE_MS - (now() - (props.createdAt || 0)))
    timers.set(String(shape.id), setTimer(() => deleteIfEligible(shape.id), delay))
  }
  const scan = () => editor.getCurrentPageShapes().forEach(shape => schedule(shape as Pill))
  scan()
  type Changes = { added?: Record<string, unknown>; updated?: Record<string, [unknown, unknown]>; removed?: Record<string, unknown> }
  const unlisten = editor.store.listen(({ changes }: { changes: Changes }) => {
    for (const record of Object.values(changes.added || {})) schedule(record as Pill)
    for (const pair of Object.values(changes.updated || {})) schedule(pair[1] as Pill)
    for (const record of Object.values(changes.removed || {})) cancelTimer(String((record as Pill).id))
  }, { source: 'all', scope: 'document' })
  const terminateActivePills = () => {
    const identity = options.getIdentity()
    for (const rawId of getActiveFleetPillIds()) {
      const id = rawId as TLShapeId
      const shape = editor.getShape(id) as Pill | undefined
      if (!shape || shape.type !== 'fleet-pill') continue
      const props = shape.props || {}
      const ownerless = !props.userId && !props.deviceId
      const local = !!identity.userId && !!identity.deviceId && props.userId === identity.userId && props.deviceId === identity.deviceId
      if (!ownerless && !local) continue
      markFleetPillInactive(rawId)
      cancelTimer(rawId)
      editor.run(() => { if (editor.getShape(id)) editor.deleteShapes([id]) }, { history: 'ignore' })
    }
  }
  const onVisibilityChange = () => documentTarget.hidden ? terminateActivePills() : scan()
  const onEscape = (event: Event) => { if ((event as KeyboardEvent).key === 'Escape') terminateActivePills() }
  windowTarget.addEventListener('online', scan)
  windowTarget.addEventListener('blur', terminateActivePills)
  windowTarget.addEventListener('pagehide', terminateActivePills)
  documentTarget.addEventListener('keydown', onEscape)
  documentTarget.addEventListener('visibilitychange', onVisibilityChange)
  return () => {
    terminateActivePills()
    disposed = true
    installedEditors.delete(editor)
    unlisten()
    windowTarget.removeEventListener('online', scan)
    windowTarget.removeEventListener('blur', terminateActivePills)
    windowTarget.removeEventListener('pagehide', terminateActivePills)
    documentTarget.removeEventListener('keydown', onEscape)
    documentTarget.removeEventListener('visibilitychange', onVisibilityChange)
    timers.forEach(clearTimer)
    timers.clear()
  }
}
