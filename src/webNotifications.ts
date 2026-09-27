import { log } from './logger.ts'

/**
 * webNotifications.ts — OS-level Web Notifications for fleet items.
 *
 * The in-canvas Notifications panel (FleetNotificationsShape) only exists
 * while Skip is looking at the tab. His ask: OS notifications "would make it
 * even more likely i'd see it". This module raises a real `Notification` for
 * each new item that lands in an attention panel — `hud` or `list` — and
 * nothing else: suggest chips and chat-only items are already where he looks.
 *
 * No service worker: fleet events arrive over the page's own socket, so there
 * is nothing to deliver while the page is closed, and a worker would add no
 * coverage. No preferences surface either: granted notifies, denied stays
 * silent, and `default` asks once on the next user gesture.
 */

export type NotifiableItem = {
  id: string
  kind?: string
  title?: string
  body?: string
  text?: string
  present?: { chat?: boolean; hud?: boolean; list?: boolean }
}

export type NotificationPermissionState = 'granted' | 'denied' | 'default'

export type NotificationCtor = new (
  title: string,
  options?: { body?: string; tag?: string; icon?: string },
  // `onclick` is `unknown` so the DOM Notification (whose handler takes an
  // Event) stays assignable; we only ever assign to it, never call it.
) => { onclick?: unknown; close?: () => void }

/** Placement wins over kind: hud/list panels collect attention, chat does not. */
export function shouldNotifyForItem(item: Pick<NotifiableItem, 'present'> | null | undefined): boolean {
  return item?.present?.hud === true || item?.present?.list === true
}

export function notificationContentFor(item: Pick<NotifiableItem, 'title' | 'body' | 'text'>): {
  title: string
  body: string
} {
  const title = (item.title ?? '').trim() || 'tlda'
  const body = (item.body ?? item.text ?? '').trim()
  return { title, body }
}

const MAX_SEEN_IDS = 500

/** Returns the items whose ids this set has not seen, remembering them. */
export function collectNewItems<T extends NotifiableItem>(seen: Set<string>, items: readonly T[]): T[] {
  const fresh: T[] = []
  for (const item of items) {
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    fresh.push(item)
  }
  if (seen.size > MAX_SEEN_IDS) {
    const drop = seen.size - MAX_SEEN_IDS
    const it = seen.values()
    for (let i = 0; i < drop; i++) seen.delete(it.next().value as string)
  }
  return fresh
}

export function showWebNotification(
  item: NotifiableItem,
  opts: {
    permission?: NotificationPermissionState | 'unsupported'
    ctor?: NotificationCtor
    focus?: () => void
  } = {},
): 'shown' | 'skipped' | 'unsupported' | 'failed' {
  const permission = opts.permission
    ?? (typeof Notification !== 'undefined' ? Notification.permission as NotificationPermissionState : 'unsupported')
  if (permission !== 'granted') return permission === 'unsupported' ? 'unsupported' : 'skipped'
  const ctor = opts.ctor ?? (typeof Notification !== 'undefined' ? Notification : undefined)
  if (typeof ctor !== 'function') return 'unsupported'
  const { title, body } = notificationContentFor(item)
  try {
    const note = new ctor(title, { body, tag: item.id, icon: '/tlda-icon-192.png' })
    note.onclick = () => {
      try {
        if (opts.focus) opts.focus()
        else if (typeof window !== 'undefined' && typeof window.focus === 'function') window.focus()
      } finally {
        if (typeof note.close === 'function') note.close()
      }
    }
    return 'shown'
  } catch (err) {
    log.debug('web-notifications', 'notification construction rejected', {
      id: item.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return 'failed'
  }
}

let permissionRequestArmed = false

/**
 * Ask once, on the next user gesture: browsers want a transient activation
 * for the permission prompt, and install time has none. Safe to call from
 * any gesture-poor context — it only registers listeners.
 */
export function requestPermissionOnNextGesture(
  doc: Pick<Document, 'addEventListener' | 'removeEventListener'> | undefined = typeof document !== 'undefined' ? document : undefined,
  request: () => Promise<unknown> = () =>
    typeof Notification !== 'undefined' ? Notification.requestPermission() : Promise.resolve('denied'),
): void {
  if (
    permissionRequestArmed
    || !doc
    || typeof Notification === 'undefined'
    || Notification.permission !== 'default'
  ) return
  permissionRequestArmed = true
  const ask = () => {
    doc.removeEventListener?.('pointerdown', ask, true)
    doc.removeEventListener?.('keydown', ask, true)
    void request().catch(() => {})
  }
  doc.addEventListener('pointerdown', ask, { once: true, capture: true })
  doc.addEventListener('keydown', ask, { once: true, capture: true })
}
