/**
 * FleetTouchInboxShape — a container shape: an inbox thread-strip on top of a
 * real fleet-chat shape.
 *
 * The strip lists your DM threads (chat scoped to (to:me) OR (from:me), grouped
 * by partner). Tapping a row sets the child chat's filter to that partner, so
 * the chat below shows and sends that conversation — "click to filter." The chat
 * is a real `fleet-chat` shape nested as a TLDraw child (same pattern as
 * PlaybackFrame), reused untouched. This container is the only new code.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  Vec,
  stopEventPropagation,
  useEditor,
  useValue,
} from 'tldraw'
import { agentDisplayLabel, beginNativeSnapDrag, endNativeSnapDrag, FLEET_SHAPE_TYPES } from './fleet-utils'
import { useCallback, useRef, useMemo, useEffect, memo } from 'react'
import { useFleetAgents, useFleetEvents, useFleetUnreadCounts, useFleetIdentity } from '../fleet-data-adapter'
// @ts-ignore — vanilla JS module
import { timeShort } from '../fleet/chat-render.mjs'
// @ts-ignore — vanilla JS module
import { getHumanId, getDeviceId, whenDeviceReady } from '../fleet/fleet-data.mjs'
import { useIsInViewport } from './useIsInViewport'
import { DATABASE_HTTP } from '../activeConfig'
import './fleet-inbox.css'
import './fleet-touch-inbox.css'

const DEFAULT_W = 380
const DEFAULT_H = 680
const STRIP_H = 200 // inbox thread-strip height; chat fills the rest
const FLEET_API = DATABASE_HTTP

// Nick color system (mirrors FleetInboxShape's)
const nickColors = ['nick-agent-0','nick-agent-1','nick-agent-2','nick-agent-3','nick-agent-4','nick-agent-5']
const nickMap = new Map<string, string>()
let nickIdx = 0
function getNickClass(agents: any[], id: string) {
  if (!id) return 'nick-agent-0'
  const a = agents.find((x: any) => x.id === id)
  if (a?.human) return 'nick-human'
  if (!nickMap.has(id)) {
    nickMap.set(id, nickColors[nickIdx % nickColors.length])
    nickIdx++
  }
  return nickMap.get(id)!
}

interface Thread {
  partnerId: string
  partnerName: string
  partnerFilterName: string
  nickClass: string
  lastTs: string
  unread: number
  preview: string
}

function previewText(text: string): string {
  if (!text) return ''
  return text
    .replace(/```[\s\S]*?```/g, '⟨code⟩')
    .replace(/\$\$[\s\S]*?\$\$/g, '⟨math⟩')
    .replace(/\$[^$\n]+\$/g, '⟨math⟩')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// The DM filter the active partner maps to — matches the convention used by
// createFleetLayout for default chat filters: all messages involving that agent.
function partnerFilter(name: string): [string, string][][] {
  return name ? [[['from', name]], [['to', name]]] : []
}

export class FleetTouchInboxShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-touch-inbox' as const
  static override props = {
    w: T.number,
    h: T.number,
    userId: T.optional(T.string),
    deviceId: T.optional(T.string),
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, userId: '', deviceId: '' }
  }

  override canEdit = () => false
  override canResize = () => true
  override canSnap = () => true
  override canBind = () => false
  override hideRotateHandle = () => true
  override onTranslateStart = () => beginNativeSnapDrag(this.editor)
  override onTranslateEnd = () => endNativeSnapDrag(this.editor)
  override onTranslateCancel = () => endNativeSnapDrag(this.editor)

  // Clip the child chat to the container bounds.
  override getClipPath(shape: any) {
    const { w, h } = shape.props
    return [new Vec(0, 0), new Vec(w, 0), new Vec(w, h), new Vec(0, h)]
  }

  // Resize the child chat with the container; the strip stays a fixed height.
  override onResize(shape: any, info: any) {
    const { editor } = this
    const children = editor.getSortedChildIdsForParent(shape.id)
      .map((id: any) => editor.getShape(id))
      .filter(Boolean) as any[]
    const newW = Math.max(120, shape.props.w * info.scaleX)
    const newH = Math.max(STRIP_H + 80, shape.props.h * info.scaleY)
    for (const child of children) {
      editor.updateShape({
        id: child.id,
        type: child.type,
        x: 0,
        y: STRIP_H,
        props: { ...child.props, w: newW, h: newH - STRIP_H },
      })
    }
    return super.onResize(shape, info)
  }

  component(shape: any) {
    return <FleetTouchInboxComponent shape={shape} />
  }

  getIndicatorPath() {
    return undefined
  }

  indicator() {
    return null
  }
}

function FleetTouchInboxInner({ shape }: { shape: any }) {
  const editor = useEditor()
  // In the HUD overlay, useEditor() is the COPY editor — shapes created/updated
  // there are clobbered by the main→copy mirror. The child chat must live on the
  // MAIN editor (set once in SvgDocument) so its id resolves there and the
  // click-to-filter write actually sticks. Route ALL child-shape ops through it.
  const mainEd = (typeof window !== 'undefined' && (window as any).__tldraw_editor__) || editor
  const { w, h } = shape.props
  const myW = w as number
  const myH = h as number

  // Capture-phase pointerdown so a tap inside the strip isn't hijacked by
  // tldraw's setPointerCapture (which would steal the pointerup and make the
  // first tap only select the shape). Mirrors FleetInboxShape / FleetSearchShape
  // — this is what makes the rows tappable on a single tap.
  const containerRef = useRef<HTMLDivElement>(null)
  const isSelectedRef = useRef(false)
  isSelectedRef.current = useValue('isSelected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement
      if (!el!.contains(target)) return
      if (isSelectedRef.current) return
      editor.markEventAsHandled(e)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [editor, shape.id])

  const identity = useFleetIdentity()
  const myId = identity.id || getHumanId()
  const myName = identity.name || ''
  const agents = useFleetAgents()

  // Scope to my DMs.
  const filter = useMemo<[string, string][][] | null>(
    () => (myName ? [[['to', myName]], [['from', myName]]] : null),
    [myName],
  )
  const events = useFleetEvents(filter)
  const unreadCounts = useFleetUnreadCounts()

  const threads = useMemo<Thread[]>(() => {
    if (!myId) return []
    const byPartner = new Map<string, any[]>()
    for (const ev of events) {
      if (ev.type !== 'chat') continue
      let partner: string | null = null
      if (ev.to === myId) partner = ev.from
      else if (ev.from === myId) partner = ev.to
      else continue
      if (!partner || partner === myId) continue
      if (!byPartner.has(partner)) byPartner.set(partner, [])
      byPartner.get(partner)!.push(ev)
    }
    const out: Thread[] = []
    for (const [partnerId, msgs] of byPartner) {
      msgs.sort((a, b) => ((a.timestamp || '') < (b.timestamp || '') ? -1 : 1))
      const last = msgs[msgs.length - 1]
      const a = agents.find((x: any) => x.id === partnerId)
      out.push({
        partnerId,
        partnerName: a ? agentDisplayLabel(a) : partnerId.replace('fleet:', ''),
        partnerFilterName: (a?.friendly_name as string) || partnerId.replace('fleet:', ''),
        nickClass: getNickClass(agents, partnerId),
        lastTs: last?.timestamp || '',
        unread: unreadCounts[partnerId] || 0,
        preview: previewText(last?.text || ''),
      })
    }
    out.sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1))
    return out
  }, [events, myId, agents, unreadCounts])

  // The child fleet-chat shape (created below), read from the MAIN editor so its
  // id matches what selectThread writes to. Its filter tells us the active partner.
  const childChat = useValue<any>(
    'childChat',
    () => mainEd.getSortedChildIdsForParent(shape.id)
      .map((id: any) => mainEd.getShape(id))
      .find((s: any) => s?.type === 'fleet-chat'),
    [mainEd, shape.id],
  )

  // Auto-populate the child chat once, below the strip — on the MAIN editor.
  useEffect(() => {
    let cancelled = false
    const createChildChat = async () => {
      await whenDeviceReady()
      if (cancelled) return
    const existing = mainEd.getSortedChildIdsForParent(shape.id)
      .map((id: any) => mainEd.getShape(id))
      .find((s: any) => s?.type === 'fleet-chat')
    if (existing) return
    const uid = getHumanId()
    if (!uid) return
    const dev = getDeviceId()
    if (!dev) return
    mainEd.createShape({
      type: 'fleet-chat' as any,
      parentId: shape.id,
      x: 0,
      y: STRIP_H,
      props: { w: myW, h: Math.max(80, myH - STRIP_H), filter: [], userId: uid, deviceId: dev },
    })
    }
    void createChildChat()
    return () => { cancelled = true }
  }, [mainEd, shape.id, myW, myH])

  // Active partner = the agent the child chat is currently filtered to.
  const activePartnerName = useMemo(() => {
    const f = childChat?.props?.filter as [string, string][][] | undefined
    if (!f || f.length === 0) return null
    for (const clause of f) for (const [, label] of clause) if (label) return label
    return null
  }, [childChat])

  const selectThread = useCallback((t: Thread) => {
    if (!childChat) return
    // Persist the filter on the MAIN shape (childChat is read from mainEd, so its
    // id resolves there) — the main→copy mirror then reflects it into the HUD.
    mainEd.updateShape({
      id: childChat.id,
      type: 'fleet-chat' as any,
      props: { ...childChat.props, filter: partnerFilter(t.partnerFilterName) },
    })
    // Mark this thread's incoming messages read — per-event, same as the inbox.
    const unread = events.filter(
      (e: any) => e.type === 'chat' && e.from === t.partnerId && e.to === myId
        && e.read !== true && (e._dbId || e.id),
    )
    for (const e of unread) {
      fetch(`${FLEET_API}/api/mark-event-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: e._dbId || e.id, agent: myId }),
      }).catch(() => {})
    }
  }, [childChat, mainEd, myId, events])

  const stripRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => { e.preventDefault(); e.stopPropagation(); el.scrollTop += e.deltaY }
    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => el.removeEventListener('wheel', onWheel, { capture: true } as any)
  }, [])

  // The container's own HTMLContainer only draws the strip; below STRIP_H it is
  // pointer-transparent so the child chat (a separate shape) gets its events.
  return (
    <HTMLContainer style={{ width: myW, height: myH, pointerEvents: 'none', overflow: 'visible' }}>
      <div
        ref={containerRef}
        className="fleet-shape fleet-inbox-shape fleet-touch-inbox-strip-wrap"
        style={{
          width: myW,
          height: STRIP_H,
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 0,
          fontSize: 11,
          overflow: 'hidden',
          fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
          fontWeight: 300,
          lineHeight: 1.4,
          position: 'relative',
          color: 'var(--text, #8888a0)',
          pointerEvents: 'all',
        }}
      >
        <div className="fleet-inbox-header">
          <span className="fleet-inbox-title">Inbox</span>
        </div>
        <div ref={stripRef} className="fleet-inbox-list">
          {threads.length === 0 && <div className="fleet-inbox-empty">no messages yet</div>}
          {threads.map((t) => {
            const active = activePartnerName === t.partnerFilterName
            return (
              <div
                key={t.partnerId}
                className={`fleet-inbox-thread${t.unread > 0 ? ' unread' : ''}${active ? ' active' : ''}`}
                onPointerUp={(e) => { stopEventPropagation(e); selectThread(t) }}
              >
                <div className="fleet-inbox-thread-row">
                  <span className={`fleet-inbox-thread-partner ${t.nickClass}`}>{t.partnerName}</span>
                  <span className="fleet-inbox-thread-time">{timeShort(t.lastTs)}</span>
                  {t.unread > 0 && <span className="fleet-inbox-thread-badge">{t.unread}</span>}
                </div>
                <div className="fleet-inbox-thread-preview">{t.preview || '…'}</div>
              </div>
            )
          })}
        </div>
      </div>
    </HTMLContainer>
  )
}

const FleetTouchInboxComponent = memo(function FleetTouchInboxComponent({ shape }: { shape: any }) {
  const { w, h } = shape.props as { w: number; h: number }
  const isInViewport = useIsInViewport(shape.id)
  if (!isInViewport) {
    return <HTMLContainer id={shape.id}><div style={{ width: w, height: h }} /></HTMLContainer>
  }
  return <FleetTouchInboxInner shape={shape} />
}, (prev, next) => prev.shape.props === next.shape.props)

// Keep the type registry honest — this is a fleet shape.
void FLEET_SHAPE_TYPES
