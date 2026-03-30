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

const PILL_W = 70
const PILL_H = 18

/** Event bus for content drops (msg references, code) → target chat textarea */
export const chatInsertBus = new EventTarget()

/** Stash for reference chip content — keyed by token string, value is hover content */
export const refStore = new Map<string, { type: string; label: string; content: string }>()

/**
 * Module-level state for filter overlay drop preview.
 * When a pill is hovering over the filter overlay, this stores the computed
 * preview so dropPillOnTarget can apply the exact previewed filter on release.
 */
export const filterDropPreview = {
  shapeId: null as string | null,
  toPreview: null as [string, string][][] | null,
  fromPreview: null as [string, string][][] | null,
  activePaneRole: null as 'to' | 'from' | null,
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
  // Find fleet-chat under the drop point manually — getShapeAtPoint skips locked shapes
  // Cast to any: custom fleet shape types aren't in tldraw's built-in type union
  const allChats = editor.getCurrentPageShapes().filter(s => (s.type as string) === 'fleet-chat') as any[]
  let hitShape: any
  for (const chat of allChats) {
    const bounds = editor.getShapePageBounds(chat.id)
    if (bounds &&
      pagePoint.x >= bounds.x && pagePoint.x <= bounds.x + bounds.w &&
      pagePoint.y >= bounds.y && pagePoint.y <= bounds.y + bounds.h) {
      hitShape = chat
      break
    }
  }

  if (hitShape && hitShape.type === 'fleet-chat') {
    // Locked shapes silently ignore updateShape — temporarily unlock for programmatic updates
    const wasLocked = hitShape.isLocked
    if (wasLocked) editor.updateShape({ id: hitShape.id, type: 'fleet-chat' as any, isLocked: false })
    const relockChat = () => { if (wasLocked) editor.updateShape({ id: hitShape.id, type: 'fleet-chat' as any, isLocked: true }) }

    // Content pill → insert reference chip token into target chat's input
    if (content) {
      // Build a short token: <<type:label>>
      // Extract a short label from the value (e.g. "msg:fleet:skip:2026-03-28T09:43:00Z" → "skip 9:43 AM")
      const pill = editor.getShape(pillId) as any
      const displayName = pill?.props?.displayName || value
      const pillType = pill?.props?.pillType || 'ref'
      const token = `«${pillType}:${displayName}»`
      refStore.set(token, { type: pillType, label: displayName, content })
      chatInsertBus.dispatchEvent(new CustomEvent('insert', {
        detail: { chatId: hitShape.id, text: token },
      }))
      return
    }

    // Agent/label pill → modify filter
    // If the filter overlay is open and has a preview, use its computed filter
    if (filterDropPreview.shapeId === hitShape.id && filterDropPreview.activePaneRole) {
      const preview = filterDropPreview.activePaneRole === 'to'
        ? filterDropPreview.toPreview
        : filterDropPreview.fromPreview
      if (preview) {
        editor.updateShape({
          id: hitShape.id,
          type: 'fleet-chat' as any,
          props: { filter: preview },
        })
        relockChat()
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
    editor.updateShape({
      id: hitShape.id,
      type: 'fleet-chat' as any,
      props: { ...hitShape.props, filter: newFilter },
    })
    relockChat()
    chatInsertBus.dispatchEvent(new CustomEvent('filter-applied', {
      detail: { chatId: hitShape.id },
    }))
  } else if ((editor.getShape(pillId) as any)?.type === 'fleet-pill' &&
             (editor.getShape(pillId) as any)?.props?.pillType === 'doc') {
    // Doc pill dropped on canvas → share if needed, then navigate
    const pill = editor.getShape(pillId) as any
    const docValue = pill.props.value as string // "file:/path" or "doc:name"
    // Navigate to doc: dispatch event for BookViewer to handle in-place,
    // or open in new tab if we're not in the right book
    const openDoc = async (docName: string) => {
      // Ensure content is current
      await fetch(`/api/projects/${encodeURIComponent(docName)}/build`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      }).catch(() => {})
      // Try in-place navigation via BookViewer event
      const notHandled = window.dispatchEvent(new CustomEvent('fleet-open-doc', {
        detail: { docName, book: 'fleet-workspace' },
        cancelable: true,
      }))
      // dispatchEvent returns false if preventDefault was called (= handled)
      if (notHandled) {
        const url = new URL(window.location.href)
        url.searchParams.set('doc', 'fleet-workspace')
        url.hash = docName
        window.open(url.toString(), '_blank')
      }
    }
    if (docValue.startsWith('doc:')) {
      openDoc(docValue.slice(4))
    } else if (docValue.startsWith('file:')) {
      const filePath = docValue.slice(5)
      ;(async () => {
        try {
          const res = await fetch('/api/share-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath, book: 'fleet-workspace' }),
          })
          const data = await res.json()
          openDoc(data?.doc || 'fleet-workspace')
        } catch (e) {
          console.error('[fleet] Failed to share file:', e)
        }
      })()
    }
  } else if (!content && (!hitShape || (hitShape as any).type !== 'fleet-agents')) {
    // Drop on empty canvas → create new fleet-chat, always unlocked
    editor.createShape({
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

  override onTranslateEnd = (_initial: TLShape, current: TLShape) => {
    const editor = this.editor
    const pill = current as any

    const bounds = editor.getShapePageBounds(pill.id)
    const centerX = bounds ? bounds.x + bounds.w / 2 : pill.x + pill.props.w / 2
    const centerY = bounds ? bounds.y + bounds.h / 2 : pill.y + pill.props.h / 2

    dropPillOnTarget(editor, pill.id, pill.props.value, { x: centerX, y: centerY })

    // Ephemeral: delete after drop
    editor.deleteShapes([pill.id])
  }

  component(shape: any) {
    const { displayName, color, pillType } = shape.props
    const isContent = pillType === 'msg' || pillType === 'code' || pillType === 'activity' || pillType === 'tool'
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
