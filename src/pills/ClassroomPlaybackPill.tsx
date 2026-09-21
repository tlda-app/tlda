/**
 * ClassroomPlaybackPill — the classroom's version of the fleet icon.
 *
 * Skip, 2026-09-18: the classroom's only fleet shape is the doc-view, so the
 * classroom gets no basestar and no fleet layouts — this button is the layout
 * chooser, with the recording indicator as its icon. Click toggles the owned
 * doc-view between here (pinned transport) and away (hidden); drag opens the
 * same CornerButtonSlider the fleet icon uses, with the doc-view placements.
 *
 * Like FleetIconPill this writes real shapes, so it works where the editor is
 * writable. A read-only student cannot create shapes — that route stays open
 * work, not something this button papers over.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createShapeId, stopEventPropagation, type Editor } from 'tldraw'
import { useFleetIdentity } from '../fleet-data-adapter'
// @ts-ignore — vanilla JS module
import { getDeviceId, getHumanId, whenDeviceReady } from '../fleet/fleet-data.mjs'
import { getDocumentPageBounds } from '../shapes/fleet-utils'
import { isFleetShapeForOwnerKey } from '../shapes/fleet-ownership'
import { fleetPanelDefaultProps } from '../shapes/fleet-panel-registry'
import { CornerButtonSlider, pickCornerSliderIndex } from '../CornerButtonSlider'
import { chromeConditionClass, useChromeConditionSeverity } from '../chrome/useChromeConditions'
import './ClassroomPlaybackPill.css'

const DRAG_THRESHOLD = 6
const ITEM_W = 44
const ITEM_GAP = 4

type DocViewPlacement = 'here' | 'above' | 'away' | 'off'

const PLACEMENTS: { id: DocViewPlacement; title: string }[] = [
  { id: 'here', title: 'Doc-view here: show the playback doc-view' },
  { id: 'above', title: 'Doc-view above: show it above the document' },
  { id: 'away', title: 'Doc-view away: keep it, parked off screen' },
  { id: 'off', title: 'Off: remove the playback doc-view' },
]

function docViewSlotId(userId: string, deviceId: string, routeScoped = false) {
  const localSuffix = routeScoped ? '-app-local' : ''
  return createShapeId(`fleet-docview-class-${userId.replace('fleet:', '')}-${deviceId}${localSuffix}`)
}

function ownedDocView(editor: Editor, userId: string, deviceId: string, routeScoped = false) {
  if (routeScoped) return editor.getShape(docViewSlotId(userId, deviceId, true)) as any
  return (editor.getCurrentPageShapes() as any[])
    .find(shape => shape.type === 'fleet-docview' && isFleetShapeForOwnerKey(shape, userId, deviceId)) as any
}

/**
 * Move, create, or delete the owned doc-view. Returns false when there is
 * nothing to act with yet — no identity, no device, no document bounds — so
 * the caller knows not to report a placement that never happened.
 */
function applyPlacement(editor: Editor, placement: DocViewPlacement, routeScoped = false): boolean {
  const userId = getHumanId()
  const deviceId = getDeviceId()
  if (!userId || !deviceId) return false
  const bounds = placement === 'off' ? null : getDocumentPageBounds(editor)
  if (placement !== 'off' && !bounds) return false
  const existing = ownedDocView(editor, userId, deviceId, routeScoped)
  if (placement === 'off' && !existing) return true
  const id = docViewSlotId(userId, deviceId, routeScoped)

  const write = () => {
    if (placement === 'off') {
      if (existing) editor.deleteShape(existing.id)
      return
    }
    if (!bounds) return
    if (existing) {
      const currentPageId = editor.getCurrentPageId()
      if (existing.parentId !== currentPageId) editor.reparentShapes([existing.id], currentPageId)
      if (existing.isLocked) editor.updateShape({ id: existing.id, type: existing.type, isLocked: false } as any)
      // x/y live on the shape, not in props — props carry only the panel's
      // own state (w/h/sources/label/…). Putting x in props fails shape
      // validation (NaN at shape.x) and crashes the canvas.
      editor.updateShape({
        id: existing.id,
        type: existing.type,
        x: placement === 'above' ? bounds.minLeft : bounds.minLeft - 440,
        y: placement === 'above' ? bounds.minTop - 340 : placement === 'here' ? bounds.minTop : bounds.maxBottom + 120,
        props: { ...existing.props, timeControls: 'pinned', userId, deviceId },
      } as any)
      return
    }
    // Custom shapes are not in the editor's stock union, so every fleet
    // creation site casts — see fleet-utils `createShapes … as any`.
    editor.createShapes([{
      id,
      type: 'fleet-docview',
      parentId: editor.getCurrentPageId(),
      x: placement === 'above' ? bounds.minLeft : bounds.minLeft - 440,
      y: placement === 'above' ? bounds.minTop - 340 : placement === 'here' ? bounds.minTop : bounds.maxBottom + 120,
      isLocked: false,
      props: {
        ...fleetPanelDefaultProps('fleet-docview'),
        w: 400,
        h: 300,
        timeControls: 'pinned',
        userId,
        deviceId,
      },
    }] as any)
  }
  editor.run(write, { history: 'ignore' })
  return true
}

function currentPlacement(editor: Editor, routeScoped = false): DocViewPlacement | null {
  const userId = getHumanId()
  const deviceId = getDeviceId()
  if (!userId || !deviceId) return null
  const shape = ownedDocView(editor, userId, deviceId, routeScoped)
  if (!shape) return 'off'
  const bounds = getDocumentPageBounds(editor)
  if (!bounds) return 'here'
  const pageBounds = editor.getShapePageBounds(shape.id)
  if (!pageBounds) return 'here'
  if (pageBounds.maxY <= bounds.minTop) return 'above'
  return pageBounds.y > bounds.maxBottom ? 'away' : 'here'
}

export function ClassroomPlaybackPill({
  mainEditor,
  defaultPlacement,
  routeScoped = false,
}: {
  mainEditor: Editor
  defaultPlacement?: DocViewPlacement
  routeScoped?: boolean
}) {
  const badgeRef = useRef<HTMLSpanElement>(null)
  const identity = useFleetIdentity()
  const [placement, setPlacement] = useState<DocViewPlacement | null>(null)
  const [dragging, setDragging] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [sliderAnchor, setSliderAnchor] = useState<DOMRect | null>(null)
  const justDraggedRef = useRef(false)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const isDragRef = useRef(false)
  const selectedIdxRef = useRef<number | null>(null)
  const conditionSeverity = useChromeConditionSeverity('fleet')
  const defaultSettledRef = useRef(false)

  // identity.id in the deps: placement is unknowable until identity resolves,
  // and the click that resolves nothing must not paint a state we never wrote.
  useEffect(() => {
    let cancelled = false
    const read = () => {
      if (cancelled) return
      const current = currentPlacement(mainEditor, routeScoped)
      if (current === null) return
      if (!defaultSettledRef.current && defaultPlacement) {
        if (current === 'off') {
          defaultSettledRef.current = true
          if (!applyPlacement(mainEditor, defaultPlacement, routeScoped)) {
            defaultSettledRef.current = false
            return
          }
          setPlacement(defaultPlacement)
        } else {
          setPlacement(current)
          defaultSettledRef.current = true
        }
        return
      }
      setPlacement(current)
    }
    whenDeviceReady().then(read)
    const unsub = mainEditor.store.listen(() => {
      read()
    }, { source: 'all', scope: 'document' })
    return () => { cancelled = true; unsub() }
  }, [mainEditor, identity.id, defaultPlacement, routeScoped])

  const apply = useCallback((idx: number) => {
    if (!applyPlacement(mainEditor, PLACEMENTS[idx].id, routeScoped)) return
    setPlacement(PLACEMENTS[idx].id)
    setPickerOpen(false)
    setSliderAnchor(null)
  }, [mainEditor, routeScoped])

  const sliderOptions = useMemo(() => PLACEMENTS.map(item => ({
    id: item.id,
    label: item.title,
    render: () => (
      <svg width={20} height={20} viewBox="0 0 20 20" style={{ display: 'block' }}>
        {item.id === 'here' && <rect x={3} y={4} width={14} height={9} rx={1.5} fill="none" stroke="currentColor" strokeWidth={1.4} />}
        {item.id === 'here' && <rect x={3} y={15} width={14} height={2} rx={1} fill="currentColor" />}
        {item.id === 'above' && <rect x={3} y={3} width={14} height={5} rx={1.5} fill="none" stroke="currentColor" strokeWidth={1.4} />}
        {item.id === 'above' && <rect x={3} y={11} width={14} height={6} rx={1} fill="none" stroke="currentColor" strokeWidth={1.4} opacity={0.55} />}
        {item.id === 'away' && <rect x={3} y={4} width={14} height={9} rx={1.5} fill="none" stroke="currentColor" strokeWidth={1.4} opacity={0.45} />}
        {item.id === 'away' && <rect x={3} y={15} width={14} height={2} rx={1} fill="currentColor" opacity={0.45} />}
        {item.id === 'off' && <circle cx={10} cy={10} r={6} fill="none" stroke="currentColor" strokeWidth={1.4} />}
        {item.id === 'off' && <line x1={6} y1={6} x2={14} y2={14} stroke="currentColor" strokeWidth={1.4} />}
      </svg>
    ),
  })), [])

  const handleClick = useCallback((e: React.MouseEvent) => {
    stopEventPropagation(e)
    if (justDraggedRef.current) {
      justDraggedRef.current = false
      return
    }
    const home = defaultPlacement || 'here'
    const next: DocViewPlacement = placement === home ? 'away' : home
    if (!applyPlacement(mainEditor, next, routeScoped)) return
    setPlacement(next)
  }, [mainEditor, placement, routeScoped, defaultPlacement])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    stopEventPropagation(e)
    const start = { x: e.clientX, y: e.clientY }
    dragStartRef.current = start
    isDragRef.current = false
    selectedIdxRef.current = null
    setSliderAnchor(badgeRef.current?.getBoundingClientRect() ?? null)

    const onMove = (ev: PointerEvent) => {
      const s = dragStartRef.current
      const anchor = badgeRef.current?.getBoundingClientRect()
      if (!s) return
      const dx = ev.clientX - s.x
      const dy = ev.clientY - s.y
      if (!isDragRef.current && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        isDragRef.current = true
        setDragging(true)
      }
      if (isDragRef.current) {
        stopEventPropagation(ev)
        if (!anchor) return
        setSliderAnchor(anchor)
        const idx = pickCornerSliderIndex({ clientX: ev.clientX, anchorRect: anchor, count: PLACEMENTS.length, slotWidth: ITEM_W, gap: ITEM_GAP })
        selectedIdxRef.current = idx
        setSelectedIdx(idx)
      }
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onCancel, true)
      isDragRef.current = false
      dragStartRef.current = null
      selectedIdxRef.current = null
      setDragging(false)
      setSelectedIdx(null)
      setSliderAnchor(null)
    }

    const onUp = (ev: PointerEvent) => {
      stopEventPropagation(ev)
      if (isDragRef.current) {
        const idx = selectedIdxRef.current
        if (idx !== null) apply(idx)
        justDraggedRef.current = true
        cleanup()
        return
      }
      cleanup()
    }

    const onCancel = () => { cleanup() }

    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
  }, [apply])

  const recording = placement === 'here'

  return (
    <div
      className={'classroom-playback-pill-container' + (recording ? ' is-recording' : '')}
      title={placement === 'here' ? 'Playback doc-view shown — click to park it' : 'Playback doc-view parked — click to show it'}
    >
      <span
        ref={badgeRef}
        className={'classroom-playback-pill-badge' + chromeConditionClass(conditionSeverity)}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerUp={stopEventPropagation}
        onTouchStart={stopEventPropagation}
        onTouchEnd={stopEventPropagation}
        role="button"
        aria-label="Classroom playback: toggle the doc-view"
        style={{ touchAction: 'none' }}
      >
        {/* Recording indicator: dot in a rounded frame when the doc-view is
            here, hollow frame when parked or off. */}
        <svg viewBox="0 0 20 20" width={20} height={20} aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
          <rect x={2.5} y={2.5} width={15} height={15} rx={4} fill="none" stroke="currentColor" strokeWidth={1.6} />
          <circle cx={10} cy={10} r={3.4} fill={recording ? '#e5484d' : 'none'} stroke={recording ? 'none' : 'currentColor'} strokeWidth={1.4}>
            {recording && <animate attributeName="opacity" values="1;0.45;1" dur="1.5s" repeatCount="indefinite" />}
          </circle>
        </svg>
      </span>

      {(dragging || pickerOpen) && sliderAnchor && (
        <CornerButtonSlider
          anchorRect={sliderAnchor}
          className="classroom-playback-slider"
          options={sliderOptions}
          activeIndex={selectedIdx}
          onSelect={apply}
        />
      )}
    </div>
  )
}
