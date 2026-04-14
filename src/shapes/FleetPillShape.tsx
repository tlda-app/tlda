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
} from 'tldraw'
import type { Editor, TLShape, TLShapeId } from 'tldraw'
// @ts-ignore — vanilla JS module
import { myTldaUrl } from '../fleet/tldaUrl.mjs'

const PILL_W = 70
const PILL_H = 18

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

const FLEET_SHAPE_TYPES = new Set(['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview'])

/** Ghost slot state — updated by drag handlers (page coords), read by FleetDropGhost.
 *  `mode` tells dropPillOnTarget how to commit the drop.
 *  `screenRect` is set by the HUD editor (has its own camera transform) so
 *  FleetDropGhost can position the ghost in HUD screen space. */
export type DropSlot = {
  x: number; y: number; w: number; h: number
  mode: 'hole' | 'new-column' | 'new-row'
}
export const dropGhostState: {
  slot: DropSlot | null
  screenRect: { x: number; y: number; w: number; h: number } | null
} = { slot: null, screenRect: null }
export const dropGhostBus = new EventTarget()

const GAP = 10                // gap between shapes in the grid

/** Get the fleet grid region from ALL fleet shapes. */
function fleetGridRegion(allBounds: Array<{ id: string; x: number; y: number; w: number; h: number }>) {
  if (allBounds.length === 0) return null
  const minX = Math.min(...allBounds.map(b => b.x))
  const minY = Math.min(...allBounds.map(b => b.y))
  const maxX = Math.max(...allBounds.map(b => b.x + b.w))
  const maxY = Math.max(...allBounds.map(b => b.y + b.h))
  const colXs = [...new Set(allBounds.map(b => Math.round(b.x)))].sort((a, b) => a - b)
  const rowYs = [...new Set(allBounds.map(b => Math.round(b.y)))].sort((a, b) => a - b)
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, colXs, rowYs }
}

/**
 * Compute the target slot for a pill drop at (dropX, dropY).
 *
 * Five modes:
 *   1. Inside the bbox in an empty cell → mode='hole'
 *   2. Past the right edge of chats → mode='new-column' (append right)
 *   3. Past the left edge of chats → mode='new-column' (prepend left)
 *   4. Past the bottom edge → mode='new-row' (append bottom)
 *   5. Past the top edge → mode='new-row' (prepend top)
 *
 * Edge drops only reflow CHAT shapes — agents/search panels stay put.
 * The chat region's bounding box stays constant; it subdivides.
 */
export function computeDropSlot(
  editor: Editor,
  excludeId: TLShapeId | null,
  dropX: number,
  dropY: number,
): DropSlot | null {
  const others = editor.getCurrentPageShapes()
    .filter(s => FLEET_SHAPE_TYPES.has((s as any).type) && s.id !== excludeId)
  if (others.length === 0) return null

  const allBounds = others
    .map(s => ({ id: s.id, ...(editor.getShapePageBounds(s.id) as any) }))
    .filter((b: any) => b.w > 0) as Array<{ id: string; x: number; y: number; w: number; h: number }>
  if (allBounds.length === 0) return null

  const cr = fleetGridRegion(allBounds)

  // Full bbox (all fleet shapes) for the hole check
  const xs = [...new Set(allBounds.flatMap(b => [b.x, b.x + b.w]))].sort((a, b) => a - b)
  const ys = [...new Set(allBounds.flatMap(b => [b.y, b.y + b.h]))].sort((a, b) => a - b)
  const minX = xs[0], maxX = xs[xs.length - 1]
  const minY = ys[0], maxY = ys[ys.length - 1]

  if (cr) {
    const nCols = cr.colXs.length || 1
    const nRows = cr.rowYs.length || 1

    // Ghost slot: width/height of a single cell after subdivision
    const colW = (cr.w - GAP * (nCols - 1)) / (nCols + 1)
    const rowH = (cr.h - GAP * (nRows - 1)) / (nRows + 1)

    // --- Outside the grid → show ghost on the NEAREST edge. ---
    // No dead zone: as long as the pill is outside the fleet bbox,
    // we show a ghost on the closest side. This makes the feature
    // discoverable from anywhere on the canvas.
    const insideX = dropX >= cr.minX && dropX <= cr.maxX
    const insideY = dropY >= cr.minY && dropY <= cr.maxY
    if (!insideX || !insideY) {
      // Compute distance to each edge
      const dRight  = dropX - cr.maxX
      const dLeft   = cr.minX - dropX
      const dBottom = dropY - cr.maxY
      const dTop    = cr.minY - dropY

      // Pick the edge the pill is most clearly past. If outside on
      // both axes (corner), pick the axis with the larger overshoot.
      const hDist = Math.max(dRight, dLeft)   // how far past horizontally
      const vDist = Math.max(dBottom, dTop)    // how far past vertically

      if (hDist > vDist) {
        // Column: right or left
        if (dRight >= dLeft) {
          // Right edge — new column appended
          return { x: cr.maxX - colW, y: cr.minY, w: colW, h: cr.h, mode: 'new-column' }
        } else {
          // Left edge — new column prepended
          return { x: cr.minX, y: cr.minY, w: colW, h: cr.h, mode: 'new-column' }
        }
      } else {
        // Row: bottom or top
        if (dBottom >= dTop) {
          // Bottom edge — new row appended
          return { x: cr.minX, y: cr.maxY - rowH, w: cr.w, h: rowH, mode: 'new-row' }
        } else {
          // Top edge — new row prepended
          return { x: cr.minX, y: cr.minY, w: cr.w, h: rowH, mode: 'new-row' }
        }
      }
    }
  }

  // --- Inside bbox: existing hole ---
  if (dropX <= minX || dropX >= maxX || dropY <= minY || dropY >= maxY) return null

  const slotLeft = [...xs].reverse().find(x => x <= dropX) ?? minX
  const slotRight = xs.find(x => x >= dropX) ?? maxX
  const slotTop = [...ys].reverse().find(y => y <= dropY) ?? minY
  const slotBottom = ys.find(y => y >= dropY) ?? maxY

  const w = slotRight - slotLeft
  const h = slotBottom - slotTop
  if (w < 50 || h < 50) return null

  const PAD = 8
  const occupied = allBounds.some(b =>
    b.x + PAD < slotRight && b.x + b.w - PAD > slotLeft &&
    b.y + PAD < slotBottom && b.y + b.h - PAD > slotTop
  )
  if (occupied) return null

  return { x: slotLeft, y: slotTop, w, h, mode: 'hole' }
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
      // Use the source shape ID as the uid when available — embeds the tldraw shape ID
      // in the token so chips can be resolved live via editor.getShape() after reload.
      const sourceShapeId: string | undefined = pill?.props?.value && typeof pill.props.value === 'string' && pill.props.value.startsWith('shape:')
        ? pill.props.value : undefined
      const uid = sourceShapeId || Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
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
      // tlda-card URL is /?doc=name — use SPA URL directly in the inline-doc iframe
      const fullUrl = docValue.slice(5)
      let docName = displayName
      let embedUrl = fullUrl
      try {
        const u = new URL(fullUrl)
        docName = u.searchParams.get('doc') || displayName
        if (!u.searchParams.has('embed')) u.searchParams.set('embed', '1')
        embedUrl = u.toString()
      } catch {}
      createEditor.createShape({
        id: createShapeId(),
        type: 'inline-doc' as any,
        x: pagePoint.x - 400,
        y: pagePoint.y - 500,
        isLocked: false,
        props: {
          w: 800,
          h: 1000,
          url: embedUrl,
          title: docName,
        },
      })
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
      // doc: prefix — create inline-doc shape (renders the tlda document)
      const docName = docValue.startsWith('doc:') ? docValue.slice(4) : docValue
      createEditor.createShape({
        id: createShapeId(),
        type: 'inline-doc' as any,
        x: pagePoint.x - 400,
        y: pagePoint.y - 500,
        isLocked: false,
        props: {
          w: 800,
          h: 1000,
          url: `${myTldaUrl()}/?doc=${encodeURIComponent(docName)}&embed=1`,
          title: displayName || docName,
        },
      })
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
    // Drop on empty canvas → create new fleet-chat.
    // Smart grid: detect drop mode (hole, new-column, new-row) and
    // reflow existing shapes so the bounding box stays constant.
    const newId = createShapeId()
    const slot = computeDropSlot(createEditor, null, pagePoint.x, pagePoint.y)

    if (slot && (slot.mode === 'new-column' || slot.mode === 'new-row')) {
      // Reflow: shrink ALL existing fleet shapes along the relevant axis,
      // then place the new chat in the freed space. Bounding box stays
      // constant — subdivision, not expansion.
      const fleetShapes = createEditor.getCurrentPageShapes()
        .filter(s => FLEET_SHAPE_TYPES.has((s as any).type)) as any[]
      const gridBounds = fleetShapes.map(s => {
        const b = createEditor.getShapePageBounds(s.id) as any
        return { id: s.id, type: s.type, x: s.x, y: s.y, w: s.props?.w, h: s.props?.h, bx: b?.x, by: b?.y, bw: b?.w, bh: b?.h }
      }).filter(b => b.bw > 0)

      if (gridBounds.length === 0) {
        createEditor.createShape({
          id: newId, type: 'fleet-chat' as any,
          x: pagePoint.x, y: pagePoint.y, isLocked: false,
          props: { w: 400, h: 600, filter: [[['to', value]], [['from', value]]] },
        })
      } else {
        const gMinX = Math.min(...gridBounds.map(b => b.bx))
        const gMinY = Math.min(...gridBounds.map(b => b.by))
        const gMaxX = Math.max(...gridBounds.map(b => b.bx + b.bw))
        const gMaxY = Math.max(...gridBounds.map(b => b.by + b.bh))
        const gW = gMaxX - gMinX
        const gH = gMaxY - gMinY

        const prepend = slot.mode === 'new-column'
          ? pagePoint.x < (gMinX + gMaxX) / 2
          : pagePoint.y < (gMinY + gMaxY) / 2

        if (slot.mode === 'new-column') {
          const colXs = [...new Set(gridBounds.map(b => Math.round(b.bx)))].sort((a, b) => a - b)
          const nCols = colXs.length || 1
          const colW = (gW - GAP * (nCols - 1)) / (nCols + 1)

          const updates: any[] = []
          for (const b of gridBounds) {
            const oldColIdx = colXs.findIndex(cx => Math.abs(cx - b.bx) < 20)
            if (oldColIdx < 0) continue
            const newIdx = prepend ? oldColIdx + 1 : oldColIdx
            const newX = gMinX + newIdx * (colW + GAP)
            updates.push({ id: b.id, type: b.type, x: newX, props: { w: colW } })
          }
          createEditor.updateShapes(updates)

          const newColIdx = prepend ? 0 : nCols
          const newX = gMinX + newColIdx * (colW + GAP)
          createEditor.createShape({
            id: newId, type: 'fleet-chat' as any,
            x: newX, y: gMinY, isLocked: false,
            props: { w: colW, h: gH, filter: [[['to', value]], [['from', value]]] },
          })
        } else {
          const rowYs = [...new Set(gridBounds.map(b => Math.round(b.by)))].sort((a, b) => a - b)
          const nRows = rowYs.length || 1
          const rowH = (gH - GAP * (nRows - 1)) / (nRows + 1)

          const updates: any[] = []
          for (const b of gridBounds) {
            const oldRowIdx = rowYs.findIndex(ry => Math.abs(ry - b.by) < 20)
            if (oldRowIdx < 0) continue
            const newIdx = prepend ? oldRowIdx + 1 : oldRowIdx
            const newY = gMinY + newIdx * (rowH + GAP)
            updates.push({ id: b.id, type: b.type, y: newY, props: { h: rowH } })
          }
          createEditor.updateShapes(updates)

          const newRowIdx = prepend ? 0 : nRows
          const newY = gMinY + newRowIdx * (rowH + GAP)
          createEditor.createShape({
            id: newId, type: 'fleet-chat' as any,
            x: gMinX, y: newY, isLocked: false,
            props: { w: gW, h: rowH, filter: [[['to', value]], [['from', value]]] },
          })
        }
      }
    } else {
      // Hole or freeform: place at slot position or drop point
      createEditor.createShape({
        id: newId,
        type: 'fleet-chat' as any,
        x: slot ? slot.x : pagePoint.x,
        y: slot ? slot.y : pagePoint.y,
        isLocked: false,
        props: {
          w: slot ? slot.w : 400,
          h: slot ? slot.h : 600,
          filter: [[['to', value]], [['from', value]]],
        },
      })
    }
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

    dropPillOnTarget(editor, pill.id, pill.props.value, dropPoint)

    // Ephemeral: delete after drop
    editor.deleteShapes([pill.id])
  }

  component(shape: any) {
    const { displayName, color, pillType } = shape.props
    const isContent = pillType === 'msg' || pillType === 'code' || pillType === 'activity' || pillType === 'tool'
    const isDotForm = pillType === 'doc' || pillType === 'annotation' || pillType === 'file'

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
      </HTMLContainer>
    )
  }

  indicator() {
    return null
  }
}
