/**
 * FleetPillShape — small draggable pill for drag-to-filter.
 *
 * Pills are ephemeral — created on drag start, deleted after drop.
 * The drop logic lives in dropPillOnTarget() (shared with FleetAgentsShape).
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  createShapeId,
  useEditor,
  useValue,
} from 'tldraw'
import type { Editor, TLShape, TLShapeId } from 'tldraw'
// @ts-ignore — vanilla JS module
import { myTldaUrl } from '../fleet/tldaUrl.mjs'

const PILL_W = 70
const PILL_H = 18
const CHAT_W = 400
const CHAT_H = 600
const SNAP_THRESHOLD = 20 // px distance for edge snapping
const SNAP_GAP = 10 // gap between shapes when snapped

const FLEET_TYPES = ['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview']

// Module-level snap state — written by onTranslate, read by the component.
// The component re-renders on every translate frame, so it picks up changes.
const _snapState = {
  deltaX: 0, // offset to apply to the ghost from its natural position
  deltaY: 0,
  // Snap lines for visual feedback: arrays of { axis, pos } in page coords
  lines: [] as Array<{ axis: 'x' | 'y'; pos: number }>,
  active: false, // true during drag
}

/**
 * Snap a drop point (top-left of new 400×600 chat) to nearby fleet shape edges.
 * Snaps X to right-edge alignment (new chat sits right of existing shape)
 * and Y to top-edge or bottom-edge alignment.
 */
function snapDropPoint(editor: Editor, point: { x: number; y: number }, excludeId: TLShapeId): { x: number; y: number } {
  const fleetShapes = editor.getCurrentPageShapes()
    .filter(s => FLEET_TYPES.includes(s.type as string) && s.id !== excludeId)
  if (fleetShapes.length === 0) return point

  let { x, y } = point
  const newRight = x + CHAT_W
  const newBottom = y + CHAT_H

  // Collect edges from all fleet shapes
  const edges: { type: string; val: number; shapeEdge: string }[] = []
  for (const s of fleetShapes) {
    const b = editor.getShapePageBounds(s.id)
    if (!b) continue
    // X edges: snap new chat's left to existing right (with gap), or right to existing left
    edges.push({ type: 'x-left-to-right', val: b.x + b.w + SNAP_GAP, shapeEdge: 'right' })
    edges.push({ type: 'x-right-to-left', val: b.x - SNAP_GAP - CHAT_W, shapeEdge: 'left' })
    edges.push({ type: 'x-left-to-left', val: b.x, shapeEdge: 'left-align' })
    // Y edges: snap top-to-top, top-to-bottom, bottom-to-top
    edges.push({ type: 'y-top-to-top', val: b.y, shapeEdge: 'top-align' })
    edges.push({ type: 'y-top-to-bottom', val: b.y + b.h + SNAP_GAP, shapeEdge: 'below' })
    edges.push({ type: 'y-bottom-to-top', val: b.y - SNAP_GAP - CHAT_H, shapeEdge: 'above' })
  }

  // Find closest X snap
  let bestXDist = SNAP_THRESHOLD
  for (const e of edges) {
    if (!e.type.startsWith('x-')) continue
    const dist = Math.abs(e.val - x)
    if (dist < bestXDist) { bestXDist = dist; x = e.val }
  }
  // Also snap right edge
  for (const e of edges) {
    if (!e.type.startsWith('x-')) continue
    const dist = Math.abs(e.val - (x + CHAT_W))
    // Only snap right edge if it's closer than the left-edge snap we already found
    if (dist < bestXDist) { bestXDist = dist; /* don't move — right edge snap is implicit */ }
  }

  // Find closest Y snap
  let bestYDist = SNAP_THRESHOLD
  for (const e of edges) {
    if (!e.type.startsWith('y-')) continue
    const dist = Math.abs(e.val - y)
    if (dist < bestYDist) { bestYDist = dist; y = e.val }
  }

  return { x, y }
}

/** Event bus for content drops (msg references, code) → target chat textarea */
export const chatInsertBus = new EventTarget()

/** Content store for chip hover previews — keyed by «token» string, value is preview text.
 *  Populated when a content pill is dropped; read by the chip renderer for hover previews.
 *  Survives within a session but not across page reloads. */
export const chipContentStore = new Map<string, string>()


/**
 * Module-level state for filter overlay drop preview.
 * When a pill is hovering over the filter overlay, this stores the computed
 * preview so dropPillOnTarget can apply the exact previewed filter on release.
 */
export const filterDropPreview = {
  shapeId: null as string | null,
  toPreview: null as [string, string][][] | null,
  fromPreview: null as [string, string][][] | null,
  replacePreview: null as [string, string][][] | null,
  activePaneRole: null as 'to' | 'from' | 'replace' | null,
}


/**
 * Drop a pill value on whatever is under the given page position.
 * - Agent/label pills over fleet-chat → update filter
 * - Content pills over fleet-chat → insert text into that chat's input
 * - Over empty canvas → create new fleet-chat filtered to this value
 */
export function dropPillOnTarget(
  editor: Editor,
  pillId: TLShapeId,
  value: string,
  pagePoint: { x: number; y: number },
  content?: string,
) {
  // Prefer the main editor for shape creation — the calling editor may be a
  // CanvasClipPanel (HUD) whose readOnly mode locks new shapes.
  const mainEditor = (window as any).__tldraw_editor__ as Editor | undefined
  const createEditor = mainEditor || editor
  // pagePoint was already translated to main-editor page space by
  // onTranslateEnd (it does panel→screen→main when the pill is dragged in
  // a CanvasClipPanel). So hit-test in MAIN coords too. Using `editor`
  // (which may be the panel editor) here would silently miss because
  // the panel's page bounds and main's page bounds aren't always identical
  // (the panel's clip-panel camera + constraint can shift the effective
  // page coordinate that getShapePageBounds returns).
  const hitEditor = mainEditor || editor
  // Find fleet-chat under the drop point manually — getShapeAtPoint skips locked shapes
  // Cast to any: custom fleet shape types aren't in tldraw's built-in type union
  const allChats = hitEditor.getCurrentPageShapes().filter(s => (s.type as string) === 'fleet-chat') as any[]
  let hitShape: any
  for (const chat of allChats) {
    const bounds = hitEditor.getShapePageBounds(chat.id)
    if (bounds &&
      pagePoint.x >= bounds.x && pagePoint.x <= bounds.x + bounds.w &&
      pagePoint.y >= bounds.y && pagePoint.y <= bounds.y + bounds.h) {
      hitShape = chat
      break
    }
  }

  if (hitShape && hitShape.type === 'fleet-chat') {

    // Content pill → insert reference chip token into target chat's input
    // Only triggers when dropped on the text input area (bottom 60px of chat)
    const chatBoundsForContent = editor.getShapePageBounds(hitShape.id)
    const inTextInput = chatBoundsForContent &&
      pagePoint.y >= chatBoundsForContent.y + chatBoundsForContent.h - 60
    // Content pills that miss the text field area → do nothing (don't fall through to filter logic)
    if (content && !inTextInput) return
    if (content && inTextInput) {
      const pill = editor.getShape(pillId) as any
      const displayName = pill?.props?.displayName || value
      const pillType = pill?.props?.pillType || 'ref'
      // Embed structured data in the token's # suffix so agents can resolve it.
      // For shape-backed pills, use the shape ID. For all others, use the pill's
      // value field (e.g. "msg:fleet:release:2026-04-18T06:22:33.000Z").
      const pillValue = pill?.props?.value || ''
      const sourceShapeId: string | undefined = typeof pillValue === 'string' && pillValue.startsWith('shape:')
        ? pillValue : undefined
      const uid = sourceShapeId || pillValue || (Date.now().toString(36) + Math.random().toString(36).slice(2, 5))
      const token = `«${pillType}:${displayName}#${uid}»`
      if (content) chipContentStore.set(token, content)
      chatInsertBus.dispatchEvent(new CustomEvent('insert', {
        detail: { chatId: hitShape.id, text: token },
      }))
      return
    }

    // Agent/label pill → modify filter
    // If the filter overlay is open and has a preview, use its computed filter
    if (filterDropPreview.shapeId === hitShape.id && filterDropPreview.activePaneRole) {
      const preview = filterDropPreview.activePaneRole === 'replace'
        ? filterDropPreview.replacePreview
        : filterDropPreview.activePaneRole === 'to'
          ? filterDropPreview.toPreview
          : filterDropPreview.fromPreview
      if (preview) {
        const wasLocked = hitShape.isLocked
        if (wasLocked) createEditor.updateShape({ id: hitShape.id, type: 'fleet-chat' as any, isLocked: false })
        createEditor.updateShape({
          id: hitShape.id,
          type: 'fleet-chat' as any,
          props: { filter: preview },
        })
        if (wasLocked) createEditor.updateShape({ id: hitShape.id, type: 'fleet-chat' as any, isLocked: true })

        chatInsertBus.dispatchEvent(new CustomEvent('filter-applied', {
          detail: { chatId: hitShape.id },
        }))
        return
      }
    }

    // Fallback: no overlay open — use position-based role (top half = to, bottom half = from)
    const chatBounds = editor.getShapePageBounds(hitShape.id)
    const role = chatBounds && pagePoint.y > chatBounds.y + chatBounds.h / 2 ? 'from' : 'to'

    const existingFilter: [string, string][][] = (hitShape as any).props.filter || []
    const newTerm: [string, string] = [role, value]
    let newFilter: [string, string][][]
    if (existingFilter.length === 0) {
      newFilter = [[newTerm]]
    } else {
      const lastClause = existingFilter[existingFilter.length - 1]
      if (lastClause.some(([r, l]) => r === role && l === value)) {
        newFilter = existingFilter
      } else {
        newFilter = [
          ...existingFilter.slice(0, -1),
          [...lastClause, newTerm],
        ]
      }
    }
    const wasLocked = hitShape.isLocked
    if (wasLocked) createEditor.updateShape({ id: hitShape.id, type: 'fleet-chat' as any, isLocked: false })
    createEditor.updateShape({
      id: hitShape.id,
      type: 'fleet-chat' as any,
      props: { ...hitShape.props, filter: newFilter },
    })
    if (wasLocked) createEditor.updateShape({ id: hitShape.id, type: 'fleet-chat' as any, isLocked: true })
    chatInsertBus.dispatchEvent(new CustomEvent('filter-applied', {
      detail: { chatId: hitShape.id },
    }))
  } else if ((editor.getShape(pillId) as any)?.type === 'fleet-pill' &&
             (editor.getShape(pillId) as any)?.props?.pillType === 'file') {
    // File chip pill dropped on canvas → create collapsed math-note
    const pill = editor.getShape(pillId) as any
    const noteContent = content || pill?.props?.displayName || ''
    createEditor.createShape({
      id: createShapeId(),
      type: 'math-note' as any,
      x: pagePoint.x - 5,
      y: pagePoint.y - 5,
      isLocked: false,
      props: {
        w: 320,
        h: 50,
        text: noteContent,
        color: 'light-violet',
        autoSize: true,
        collapsed: true,
      },
    })
  } else if ((editor.getShape(pillId) as any)?.type === 'fleet-pill' &&
             (editor.getShape(pillId) as any)?.props?.pillType === 'doc') {
    // Doc/file pill dropped on canvas → create collapsed math-note with file content
    const pill = editor.getShape(pillId) as any
    const docValue = pill.props.value as string // "file:/path" or "doc:name"
    const displayName = pill?.props?.displayName || 'file'

    if (docValue.startsWith('tlda:')) {
      // tlda links: no-op on canvas drop (inline-doc iframes are broken)
      console.log('[fleet] tlda link drop ignored:', docValue)
    } else if (docValue.startsWith('file:')) {
      const filePath = docValue.slice(5)
      ;(async () => {
        try {
          const res = await fetch(`/api/read-file?path=${encodeURIComponent(filePath)}`)
          const text = res.ok ? await res.text() : `# ${displayName}\n\n(Could not read file)`
          createEditor.createShape({
            id: createShapeId(),
            type: 'math-note' as any,
            x: pagePoint.x - 5,
            y: pagePoint.y - 5,
            isLocked: false,
            props: {
              w: 300,
              h: 50,
              text,
              color: 'light-violet',
              autoSize: true,
              collapsed: true,
            },
          })
        } catch (e) {
          console.error('[fleet] Failed to read file for membrane drop:', e)
          createEditor.createShape({
            id: createShapeId(),
            type: 'math-note' as any,
            x: pagePoint.x - 5,
            y: pagePoint.y - 5,
            isLocked: false,
            props: {
              w: 300,
              h: 50,
              text: `# ${displayName}\n\n(Could not read file)`,
              color: 'light-violet',
              autoSize: true,
              collapsed: true,
            },
          })
        }
      })()
    } else {
      // doc: prefix — no-op on canvas drop (inline-doc iframes are broken)
      console.log('[fleet] doc link drop ignored:', docValue)
    }
  } else if ((editor.getShape(pillId) as any)?.type === 'fleet-pill' &&
             (editor.getShape(pillId) as any)?.props?.pillType === 'annotation') {
    // Annotation pill dropped on canvas → create collapsed math-note
    const pill = editor.getShape(pillId) as any
    const noteContent = content || pill?.props?.displayName || ''
    // Map pill color hex to a math-note color name
    const colorHex = (pill?.props?.color || '').toLowerCase()
    const hexToName: Record<string, string> = {
      '#ef4444': 'red', '#f97316': 'orange', '#eab308': 'yellow',
      '#22c55e': 'green', '#3b82f6': 'blue', '#8b5cf6': 'violet',
    }
    const noteColor = hexToName[colorHex] || 'light-blue'
    createEditor.createShape({
      id: createShapeId(),
      type: 'math-note' as any,
      x: pagePoint.x - 5,
      y: pagePoint.y - 5,
      isLocked: false,
      props: {
        w: 200,
        h: 50,
        text: noteContent,
        color: noteColor,
        autoSize: true,
        collapsed: true,
      },
    })
  } else if (!content && (!hitShape || (hitShape as any).type !== 'fleet-agents')) {
    // Drop on empty canvas → create new fleet-chat at the drop point.
    createEditor.createShape({
      id: createShapeId(),
      type: 'fleet-chat' as any,
      x: pagePoint.x,
      y: pagePoint.y,
      isLocked: false,
      props: {
        w: 400,
        h: 600,
        filter: [[['to', value]], [['from', value]]],
      },
    })
  }
}

export class FleetPillShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-pill' as const
  static override props = {
    w: T.number,
    h: T.number,
    pillType: T.string,
    value: T.string,
    displayName: T.string,
    color: T.string,
  }

  getDefaultProps() {
    return {
      w: PILL_W,
      h: PILL_H,
      pillType: 'agent',
      value: '',
      displayName: '',
      color: '#7a9ec8',
    }
  }

  override canEdit = () => false
  override canResize = () => false
  override canBind = () => false
  override canSnap = () => false
  override hideRotateHandle = () => true
  override hideSelectionBoundsBg = () => true
  override hideSelectionBoundsFg = () => true

  // Auto-delete orphaned pills that were created but never dragged
  override onTranslateStart = (shape: TLShape) => {
    // Clear any pending auto-delete since the user is actively dragging
    const timerId = (this as any).__autoDeleteTimers?.get(shape.id)
    if (timerId) clearTimeout(timerId)
    _snapState.active = true
  }

  // Compute snap during drag — updates the module-level _snapState so the
  // ghost component can offset itself and show snap lines.
  override onTranslate = (_initial: TLShape, current: TLShape) => {
    const pill = current as any
    if (pill.props?.pillType !== 'agent' && pill.props?.pillType !== 'label') return

    const editor = this.editor
    const mainEditor = (window as any).__tldraw_editor__ as Editor | undefined
    const hitEditor = mainEditor || editor

    // Get the pill center in main editor page space
    const bounds = editor.getShapePageBounds(pill.id)
    let cx = bounds ? bounds.x + bounds.w / 2 : pill.x + PILL_W / 2
    let cy = bounds ? bounds.y + bounds.h / 2 : pill.y + PILL_H / 2
    if (mainEditor && mainEditor !== editor) {
      const sp = editor.pageToScreen({ x: cx, y: cy })
      const mp = mainEditor.screenToPage(sp)
      cx = mp.x; cy = mp.y
    }

    // Ghost top-left = pill center (that's where the chat would be created)
    const ghostX = cx
    const ghostY = cy
    const ghostRight = ghostX + CHAT_W
    const ghostBottom = ghostY + CHAT_H

    // Collect snap candidates from fleet shapes
    const fleetShapes = hitEditor.getCurrentPageShapes()
      .filter(s => FLEET_TYPES.includes(s.type as string) && s.id !== pill.id)

    let bestDX = 0, bestDY = 0
    let bestDXDist = SNAP_THRESHOLD, bestDYDist = SNAP_THRESHOLD
    const lines: typeof _snapState.lines = []

    for (const s of fleetShapes) {
      const b = hitEditor.getShapePageBounds(s.id)
      if (!b) continue

      // X snaps: ghost left → shape right+gap, ghost left → shape left, ghost right → shape left-gap, ghost right → shape right
      const xSnaps = [
        { ghostEdge: ghostX, target: b.x + b.w + SNAP_GAP, linePos: b.x + b.w + SNAP_GAP / 2 },
        { ghostEdge: ghostX, target: b.x, linePos: b.x },
        { ghostEdge: ghostRight, target: b.x - SNAP_GAP, linePos: b.x - SNAP_GAP / 2 },
        { ghostEdge: ghostRight, target: b.x + b.w, linePos: b.x + b.w },
      ]
      for (const snap of xSnaps) {
        const delta = snap.target - snap.ghostEdge
        const dist = Math.abs(delta)
        if (dist < bestDXDist) {
          bestDXDist = dist
          bestDX = delta
          lines.push({ axis: 'x', pos: snap.linePos })
        }
      }

      // Y snaps: ghost top → shape top, ghost top → shape bottom+gap, ghost bottom → shape top-gap, ghost bottom → shape bottom
      const ySnaps = [
        { ghostEdge: ghostY, target: b.y, linePos: b.y },
        { ghostEdge: ghostY, target: b.y + b.h + SNAP_GAP, linePos: b.y + b.h + SNAP_GAP / 2 },
        { ghostEdge: ghostBottom, target: b.y - SNAP_GAP, linePos: b.y - SNAP_GAP / 2 },
        { ghostEdge: ghostBottom, target: b.y + b.h, linePos: b.y + b.h },
      ]
      for (const snap of ySnaps) {
        const delta = snap.target - snap.ghostEdge
        const dist = Math.abs(delta)
        if (dist < bestDYDist) {
          bestDYDist = dist
          bestDY = delta
          lines.push({ axis: 'y', pos: snap.linePos })
        }
      }
    }

    // Only keep lines for the winning snap
    _snapState.deltaX = bestDXDist < SNAP_THRESHOLD ? bestDX : 0
    _snapState.deltaY = bestDYDist < SNAP_THRESHOLD ? bestDY : 0
    _snapState.lines = lines.filter(l =>
      (l.axis === 'x' && bestDXDist < SNAP_THRESHOLD) ||
      (l.axis === 'y' && bestDYDist < SNAP_THRESHOLD)
    ).slice(-2) // keep at most 2 lines (one X, one Y)
  }

  onCreate = (shape: TLShape) => {
    // Auto-delete after 5s if never dragged (accidental grab)
    if (!(this as any).__autoDeleteTimers) (this as any).__autoDeleteTimers = new Map()
    const timer = setTimeout(() => {
      if (this.editor.getShape(shape.id)) {
        this.editor.deleteShapes([shape.id])
      }
    }, 5000)
    ;(this as any).__autoDeleteTimers.set(shape.id, timer)
    return shape
  }

  override onTranslateEnd = (_initial: TLShape, current: TLShape) => {
    const editor = this.editor
    const pill = current as any

    // Convert pill's page position to screen, then to main editor's page space.
    // This handles the case where the pill is dragged in a CanvasClipPanel (HUD)
    // which has a different camera than the main editor.
    const bounds = editor.getShapePageBounds(pill.id)
    const pageCenterX = bounds ? bounds.x + bounds.w / 2 : pill.x + pill.props.w / 2
    const pageCenterY = bounds ? bounds.y + bounds.h / 2 : pill.y + pill.props.h / 2

    const mainEditor = (window as any).__tldraw_editor__ as Editor | undefined
    let dropPoint = { x: pageCenterX, y: pageCenterY }

    if (mainEditor && mainEditor !== editor) {
      // Panel editor → screen → main editor page space
      const screenPoint = editor.pageToScreen({ x: pageCenterX, y: pageCenterY })
      dropPoint = mainEditor.screenToPage(screenPoint)
    }

    // Apply snap delta from the visual snap computed during drag
    const pillType = pill.props?.pillType
    if ((pillType === 'agent' || pillType === 'label') && _snapState.active) {
      dropPoint.x += _snapState.deltaX
      dropPoint.y += _snapState.deltaY
    }
    _snapState.active = false
    _snapState.deltaX = 0
    _snapState.deltaY = 0
    _snapState.lines = []

    dropPillOnTarget(editor, pill.id, pill.props.value, dropPoint)

    // Ephemeral: delete after drop
    editor.deleteShapes([pill.id])
  }

  component(shape: any) {
    const editor = useEditor()
    const { displayName, color, pillType } = shape.props
    const isContent = pillType === 'msg' || pillType === 'code' || pillType === 'activity' || pillType === 'tool'
    const isDotForm = pillType === 'doc' || pillType === 'annotation' || pillType === 'file'
    const isAgentPill = pillType === 'agent' || pillType === 'label'

    // Hide ghost when the pill is over an existing fleet shape (drop = filter update, not new chat)
    const overFleetShape = useValue('pill-over-fleet', () => {
      if (!isAgentPill) return false
      const bounds = editor.getShapePageBounds(shape.id)
      if (!bounds) return false
      const cx = bounds.x + bounds.w / 2
      const cy = bounds.y + bounds.h / 2
      return editor.getCurrentPageShapes().some(s => {
        if (s.id === shape.id || !FLEET_TYPES.includes(s.type as string)) return false
        const sb = editor.getShapePageBounds(s.id)
        return sb && cx >= sb.x && cx <= sb.x + sb.w && cy >= sb.y && cy <= sb.y + sb.h
      })
    }, [editor, shape.id, isAgentPill])

    // Dot form: small colored circle (like collapsed math-note)
    if (isDotForm) {
      return (
        <HTMLContainer
          style={{
            pointerEvents: 'none',
            overflow: 'visible',
            width: 0,
            height: 0,
          }}
        >
          <div style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            backgroundColor: color,
            boxShadow: `0 0 0 2px ${color}33, 0 0 8px ${color}40`,
            cursor: 'grab',
          }} />
        </HTMLContainer>
      )
    }

    return (
      <HTMLContainer
        style={{
          pointerEvents: 'none',
          overflow: 'visible',
          width: 0,
          height: 0,
        }}
      >
        <div
          className="fleet-pill-ghost"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '1px 6px',
            borderRadius: 3,
            border: `1px solid ${color}60`,
            background: `${color}15`,
            color: color,
            fontSize: 9,
            fontWeight: 500,
            cursor: 'grab',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            lineHeight: '14px',
            fontFamily: "'SF Mono', Menlo, Consolas, monospace",
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {isContent ? `📎 ${displayName}` : displayName}
          </span>
        </div>
        {/* Ghost: show where a new chat will be created when dropping an agent/label pill.
            Hidden when over an existing fleet shape (drop = filter update, not new chat).
            Chat is created at the pill's center (PILL_W/2, PILL_H/2), so the ghost's
            top-left starts there. Snap delta offsets the ghost during drag. */}
        {isAgentPill && !overFleetShape && (
          <>
            <div
              className="fleet-chat-shape"
              style={{
                position: 'absolute',
                top: PILL_H / 2 + _snapState.deltaY,
                left: PILL_W / 2 + _snapState.deltaX,
                width: CHAT_W,
                height: CHAT_H,
                opacity: 0.5,
                pointerEvents: 'none',
                display: 'flex',
                flexDirection: 'column',
                transition: _snapState.deltaX || _snapState.deltaY ? 'none' : 'top 0.1s, left 0.1s',
              }}
            >
              <div style={{
                padding: '4px 8px',
                fontSize: 10,
                borderBottom: '1px solid rgba(128, 128, 128, 0.1)',
                color: 'var(--text-dim)',
                fontFamily: "'SF Mono', Menlo, Consolas, monospace",
              }}>
                → {displayName}
              </div>
              <div style={{ flex: 1 }} />
              <div style={{
                height: 28,
                borderTop: '1px solid rgba(128, 128, 128, 0.1)',
                margin: '0 4px 4px',
                borderRadius: 4,
                background: 'rgba(128, 128, 128, 0.05)',
              }} />
            </div>
            {/* Snap indicator — subtle border highlight when snapped */}
            {(_snapState.deltaX !== 0 || _snapState.deltaY !== 0) && (
              <div style={{
                position: 'absolute',
                top: PILL_H / 2 + _snapState.deltaY - 1,
                left: PILL_W / 2 + _snapState.deltaX - 1,
                width: CHAT_W + 2,
                height: CHAT_H + 2,
                border: '1px solid #4dabf7',
                borderRadius: 9,
                pointerEvents: 'none',
                opacity: 0.4,
              }} />
            )}
          </>
        )}
      </HTMLContainer>
    )
  }

  indicator() {
    return null
  }
}
