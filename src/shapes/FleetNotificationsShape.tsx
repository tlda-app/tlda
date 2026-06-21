import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
} from 'tldraw'
import { useEffect, useRef, type SyntheticEvent } from 'react'
import { dismissItem, sendMessage, useItems, type Item, type ItemAction } from '../fleet-data-adapter'
import './fleet-notifications.css'

const DEFAULT_W = 360
const DEFAULT_H = 220

export class FleetNotificationsShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-notifications' as const
  static override props = {
    w: T.number,
    h: T.number,
    userId: T.optional(T.string),
    deviceId: T.optional(T.string),
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, userId: '', deviceId: '' }
  }

  override canEdit = () => true
  override canResize = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

  component(shape: any) {
    return <FleetNotificationsComponent shape={shape} />
  }

  getIndicatorPath() {
    return undefined
  }

  indicator() {
    return null
  }
}

function FleetNotificationsComponent({ shape }: { shape: any }) {
  const { w, h } = shape.props
  const items = useItems('hud')
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const stop = (e: PointerEvent | WheelEvent) => {
      if (el.contains(e.target as Node)) e.stopPropagation()
    }
    el.addEventListener('pointerdown', stop, true)
    el.addEventListener('wheel', stop, { capture: true, passive: false })
    return () => {
      el.removeEventListener('pointerdown', stop, true)
      el.removeEventListener('wheel', stop, true)
    }
  }, [])

  return (
    <HTMLContainer>
      <div
        ref={containerRef}
        className="fleet-shape fleet-notifications-shape"
        style={{ width: w, height: h }}
        onPointerDown={stopEventPropagation}
      >
        <div className="fleet-notifications-header">
          <span className="fleet-notifications-title">Notifications</span>
          {items.length > 0 && <span className="fleet-notifications-count">{items.length}</span>}
        </div>
        <div className="fleet-notifications-list">
          {items.length === 0 && <div className="fleet-notifications-empty">no notifications</div>}
          {[...items].sort(sortItems).map(item => <NotificationCard key={item.id} item={item} />)}
        </div>
      </div>
    </HTMLContainer>
  )
}

function sortItems(a: Item, b: Item) {
  const ap = a.priority === 'high' ? 1 : 0
  const bp = b.priority === 'high' ? 1 : 0
  if (ap !== bp) return bp - ap
  return (b.ts || 0) - (a.ts || 0)
}

function NotificationCard({ item }: { item: Item }) {
  const actions = item.actions || []
  const close = (e: SyntheticEvent) => {
    e.stopPropagation()
    dismissItem(item.id).catch(err => console.warn('dismissItem failed', err))
  }
  const act = (action: ItemAction) => (e: SyntheticEvent) => {
    e.stopPropagation()
    if (action.command) sendMessage(action.target || item.from || '', action.command)
    dismissItem(item.id).catch(err => console.warn('dismissItem failed', err))
  }
  return (
    <div className={`fleet-notification-card priority-${item.priority || 'normal'}`}>
      <div className="fleet-notification-top">
        <span className="fleet-notification-kind">{item.kind}</span>
        <button className="fleet-notification-dismiss" title="Dismiss" onClick={close}>x</button>
      </div>
      <div className="fleet-notification-title">{item.title}</div>
      {item.body && <div className="fleet-notification-body">{item.body}</div>}
      {actions.length > 0 && (
        <div className="fleet-notification-actions">
          {actions.map((a: ItemAction, i: number) => (
            <button key={`${a.label}-${i}`} onClick={act(a)}>{a.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}
