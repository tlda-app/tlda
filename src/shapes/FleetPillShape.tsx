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
// @ts-ignore — vanilla JS module
import { getHumanId, getDeviceId } from '../fleet/fleet-data.mjs'
import { translateFleetHudDropPoint } from '../wm/fleet-hud-layer'
import { FLEET_SHAPE_TYPES } from './fleet-utils'

const PILL_W = 70
const PILL_H = 18
const CHAT_W = 400
const CHAT_H = 600
const TEMP_MARKDOWN_PROJECT = 'fleet-markdown-chip-temp'
const TEMP_MARKDOWN_FILE = 'content.md'
const TEMP_MARKDOWN_SHAPE_ID = createShapeId('fleet-markdown-chip-temp-column')
const TEMP_MARKDOWN_W = 800
const TEMP_MARKDOWN_H = 1200
const TEMP_MARKDOWN_PARKING_OFFSET = 50000

const FLEET_TYPES = FLEET_SHAPE_TYPES

// Module-level snap state — written by drag handler, read by the component.
// The component re-renders on every translate frame, so it picks up changes.
const _snapState = {
  deltaX: 0,
  deltaY: 0,
  lines: [] as Array<{ axis: 'x' | 'y'; pos: number }>,
  active: false, // true during drag
  expanded: false, // true when pill is expanded to chat dimensions (over empty canvas)
  prevSnapMode: undefined as boolean | undefined,
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

function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function ensureTemporaryMarkdownProject() {
  const createRes = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: TEMP_MARKDOWN_PROJECT,
      title: 'Markdown chip',
      format: 'markdown',
      mainFile: TEMP_MARKDOWN_FILE,
    }),
  })
  if (!createRes.ok && createRes.status !== 409) {
    throw new Error(`project create failed: ${createRes.status}`)
  }
}

async function waitForTemporaryMarkdownBuild(startedAt: number, allowExisting = false) {
  const deadline = startedAt + 8000
  while (Date.now() < deadline) {
    const res = await fetch(`/api/projects/${TEMP_MARKDOWN_PROJECT}?t=${Date.now()}`)
    if (res.ok) {
      const project = await res.json()
      const lastBuild = project.lastBuild ? Date.parse(project.lastBuild) : 0
      if (project.buildStatus === 'success' && project.pages > 0 && (allowExisting || lastBuild >= startedAt - 1000)) return
      if (project.buildStatus === 'error') throw new Error('markdown build failed')
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('markdown build timed out')
}

function getParkedMarkdownPoint(editor: Editor, fallbackPoint: { x: number; y: number }) {
  const occupiedBounds = []
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.meta?.temporaryMarkdownColumn) continue
    const bounds = editor.getShapePageBounds(shape.id)
    if (bounds) occupiedBounds.push(bounds)
  }

  if (!occupiedBounds.length) {
    return {
      x: fallbackPoint.x - TEMP_MARKDOWN_PARKING_OFFSET,
      y: fallbackPoint.y - TEMP_MARKDOWN_PARKING_OFFSET,
    }
  }

  const minX = Math.min(...occupiedBounds.map(bounds => bounds.x))
  const minY = Math.min(...occupiedBounds.map(bounds => bounds.y))
  return {
    x: minX - TEMP_MARKDOWN_W - TEMP_MARKDOWN_PARKING_OFFSET,
    y: minY - TEMP_MARKDOWN_H - TEMP_MARKDOWN_PARKING_OFFSET,
  }
}

function sendPageShapeToBack(editor: Editor, shapeId: TLShapeId) {
  const shape = editor.getShape(shapeId)
  if (!shape) return
  if (shape.isLocked) editor.updateShape({ id: shapeId, type: shape.type, isLocked: false })
  editor.sendToBack([shapeId])
  editor.updateShape({ id: shapeId, type: shape.type, isLocked: true })
}

function getShapeClipBounds(editor: Editor, shapeId: TLShapeId) {
  const bounds = editor.getShapePageBounds(shapeId)
  if (!bounds) return null
  return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }
}

export async function createTemporaryMarkdownColumn(
  editor: Editor,
  pagePoint: { x: number; y: number },
  title: string,
  markdown: string,
  meta: Record<string, unknown> = {},
) {
  const source = markdown.trim() ? markdown : `# ${title || 'Markdown chip'}`
  const startedAt = Date.now()
  await ensureTemporaryMarkdownProject()
  const pushRes = await fetch(`/api/projects/${TEMP_MARKDOWN_PROJECT}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{
        path: TEMP_MARKDOWN_FILE,
        content: encodeUtf8Base64(source),
        encoding: 'base64',
      }],
    }),
  })
  if (!pushRes.ok) throw new Error(`markdown push failed: ${pushRes.status}`)
  const pushResult = await pushRes.json().catch(() => null)
  await waitForTemporaryMarkdownBuild(startedAt, !!pushResult?.unchanged)

  const url = `/docs/${TEMP_MARKDOWN_PROJECT}/index.html?t=${Date.now()}`
  const parkedPoint = getParkedMarkdownPoint(editor, pagePoint)
  const existing = editor.getShape(TEMP_MARKDOWN_SHAPE_ID)
  if (existing) {
    if (existing.isLocked) {
      editor.updateShape({ id: TEMP_MARKDOWN_SHAPE_ID, type: existing.type, isLocked: false })
    }
    editor.updateShape({
      id: TEMP_MARKDOWN_SHAPE_ID,
      type: 'html-page',
      x: parkedPoint.x,
      y: parkedPoint.y,
      isLocked: true,
      props: { w: TEMP_MARKDOWN_W, h: TEMP_MARKDOWN_H, url },
      meta: {
        ...existing.meta,
        temporaryMarkdownColumn: true,
        title,
        updatedAt: Date.now(),
        ...meta,
      },
    } as unknown as Parameters<Editor['updateShape']>[0])
  } else {
    editor.createShape({
      id: TEMP_MARKDOWN_SHAPE_ID,
      type: 'html-page',
      x: parkedPoint.x,
      y: parkedPoint.y,
      isLocked: true,
      props: { w: TEMP_MARKDOWN_W, h: TEMP_MARKDOWN_H, url },
      meta: {
        temporaryMarkdownColumn: true,
        title,
        createdAt: Date.now(),
        ...meta,
      },
    } as unknown as Parameters<Editor['createShape']>[0])
  }
  sendPageShapeToBack(editor, TEMP_MARKDOWN_SHAPE_ID)
  return {
    shapeId: TEMP_MARKDOWN_SHAPE_ID,
    bounds: getShapeClipBounds(editor, TEMP_MARKDOWN_SHAPE_ID) || {
      x: parkedPoint.x,
      y: parkedPoint.y,
      w: TEMP_MARKDOWN_W,
      h: TEMP_MARKDOWN_H,
    },
    url,
  }
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
  // Isolate this drop as its own undo step. A pill drop creates a chat (or note,
  // or updates a filter) directly via createEditor.createShape — NOT through
  // createFleetShape — so without a mark here the new chat glues onto whatever
  // the user did just before (e.g. a move/resize), and one undo wrongly reverses
  // that prior operation. Mark before any of the drop's mutations.
  createEditor.markHistoryStoppingPoint?.()
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
  // Whether the drop landed on ANY fleet shape (the HUD), not just a fleet-chat.
  // A sticky/new-chat must never be created on top of the HUD — it sits over the
  // fixed overlay and becomes undismissable. So if the drop is over a fleet
  // shape and isn't a handled fleet-chat interaction, the create paths below
  // evaporate it (see the guard before the create branches).
  const overFleet = hitEditor.getCurrentPageShapes().some(s => {
    if (!FLEET_TYPES.has(s.type as string)) return false
    const b = hitEditor.getShapePageBounds(s.id)
    return !!b &&
      pagePoint.x >= b.x && pagePoint.x <= b.x + b.w &&
      pagePoint.y >= b.y && pagePoint.y <= b.y + b.h
  })

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
  } else if (overFleet) {
    // Drop landed on the HUD (a fleet shape) but isn't a handled fleet-chat
    // interaction — evaporate instead of spawning a sticky/new-chat on top of
    // the fixed overlay, where it sits on top and becomes undismissable. The
    // caller deletes the dragged pill after this returns, so nothing is left.
    return
  } else if ((editor.getShape(pillId) as any)?.type === 'fleet-pill' &&
             (editor.getShape(pillId) as any)?.props?.pillType === 'file') {
    // File/markdown chip dropped on canvas → render it as a page-like html column.
    const pill = editor.getShape(pillId) as any
    const sourceAgent = pill?.meta?.sourceAgent as string | undefined
    const filePath = pill?.meta?.filePath as string | undefined
    const fileUrl = pill?.meta?.fileUrl as string | undefined
    const title = pill?.props?.displayName || filePath?.split('/').pop() || 'Markdown chip'
    const fetchUrl = fileUrl || (filePath ? `/api/read-file?path=${encodeURIComponent(filePath)}` : '')
    ;(async () => {
      try {
        let markdown = content || title
        if (fetchUrl) {
          const res = await fetch(fetchUrl)
          if (res.ok) markdown = await res.text()
        }
        await createTemporaryMarkdownColumn(createEditor, pagePoint, title, markdown, {
          ...(sourceAgent ? { authorId: sourceAgent, fromAgent: sourceAgent } : {}),
          ...(filePath ? { sharedDocPath: filePath, sharedDoc: true } : {}),
        })
      } catch (e: any) {
        console.warn('[fleet-pill] markdown column create failed:', e?.message || e)
      }
    })()
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
              collapsed: false, // open sticky, not a touch-untappable dot
              backingFile: filePath,
            },
          })
          // Register backing file watch so the server notifies us when the file changes on disk
          const docName = new URLSearchParams(window.location.search).get('doc') || ''
          if (docName) {
            fetch('/api/backing-file-register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filePath, docName }),
            }).catch(e => console.warn('[fleet-pill] backing file register failed:', e.message))
          }
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
              collapsed: false, // open sticky, not a touch-untappable dot
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
        // Stamp ownership — without this the chat has userId '' and the
        // ownership rule (isMyFleetShape) never renders it, so the drop looked
        // like it did nothing. deviceId is the other half of the key.
        userId: getHumanId(),
        deviceId: getDeviceId(),
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
  override canSnap = (shape: any) => shape.props?.pillType === 'agent' || shape.props?.pillType === 'label'
  override hideRotateHandle = () => true
  override hideSelectionBoundsBg = () => true
  override hideSelectionBoundsFg = () => true

  // Auto-delete orphaned pills that were created but never dragged
  override onTranslateStart = (shape: TLShape) => {
    // Clear any pending auto-delete since the user is actively dragging
    const timerId = (this as any).__autoDeleteTimers?.get(shape.id)
    if (timerId) clearTimeout(timerId)
    _snapState.active = true
    _snapState.expanded = false

    // Enable snap mode during pill drag so TLDraw shows native snap guides.
    // Save previous state to restore on translate end.
    const pill = shape as any
    if (pill.props?.pillType === 'agent' || pill.props?.pillType === 'label') {
      _snapState.prevSnapMode = this.editor.user.getIsSnapMode()
      this.editor.user.updateUserPreferences({ isSnapMode: true })
    }
  }

  // During drag: expand pill to chat dimensions when over empty canvas,
  // collapse back when over a fleet shape. TLDraw's native snap handles
  // the expanded pill like any other shape.
  override onTranslate = (_initial: TLShape, current: TLShape) => {
    const pill = current as any
    if (pill.props?.pillType !== 'agent' && pill.props?.pillType !== 'label') return

    const editor = this.editor
    const mainEditor = (window as any).__tldraw_editor__ as Editor | undefined
    const hitEditor = mainEditor || editor

    // Check if pill center is over an existing fleet shape
    const bounds = editor.getShapePageBounds(pill.id)
    const cx = bounds ? bounds.x + bounds.w / 2 : pill.x + (pill.props.w || PILL_W) / 2
    const cy = bounds ? bounds.y + bounds.h / 2 : pill.y + (pill.props.h || PILL_H) / 2

    let overFleet = false
    const allFleet = hitEditor.getCurrentPageShapes()
      .filter(s => FLEET_TYPES.has(s.type as string) && s.id !== pill.id)
    for (const s of allFleet) {
      const sb = hitEditor.getShapePageBounds(s.id)
      if (sb && cx >= sb.x && cx <= sb.x + sb.w && cy >= sb.y && cy <= sb.y + sb.h) {
        overFleet = true
        break
      }
    }

    // Expand to chat dimensions when over empty canvas, collapse when over fleet shape
    const shouldExpand = !overFleet
    if (shouldExpand && !_snapState.expanded) {
      _snapState.expanded = true
      editor.updateShape({
        id: pill.id,
        type: pill.type,
        props: { w: CHAT_W, h: CHAT_H },
      })
    } else if (!shouldExpand && _snapState.expanded) {
      _snapState.expanded = false
      editor.updateShape({
        id: pill.id,
        type: pill.type,
        props: { w: PILL_W, h: PILL_H },
      })
    }
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
      dropPoint = translateFleetHudDropPoint(editor, mainEditor, dropPoint)
    }

    // When expanded (pill was 400×600), the drop point is already the
    // pill's center which = the chat's center. Adjust to top-left.
    if (_snapState.expanded) {
      dropPoint.x -= CHAT_W / 2
      dropPoint.y -= CHAT_H / 2
    }
    // Restore snap mode
    if (_snapState.prevSnapMode !== undefined) {
      this.editor.user.updateUserPreferences({ isSnapMode: _snapState.prevSnapMode })
    }
    _snapState.active = false
    _snapState.expanded = false
    _snapState.prevSnapMode = undefined
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
    const isFileBackedDoc = pillType === 'doc' && typeof shape.props.value === 'string' && shape.props.value.startsWith('file:')
    const isDotForm = (pillType === 'doc' && !isFileBackedDoc) || pillType === 'annotation' || pillType === 'file'
    const isAgentPill = pillType === 'agent' || pillType === 'label'

    // Hide ghost when the pill is over an existing fleet shape (drop = filter update, not new chat)
    const overFleetShape = useValue('pill-over-fleet', () => {
      if (!isAgentPill) return false
      const bounds = editor.getShapePageBounds(shape.id)
      if (!bounds) return false
      const cx = bounds.x + bounds.w / 2
      const cy = bounds.y + bounds.h / 2
      return editor.getCurrentPageShapes().some(s => {
        if (s.id === shape.id || !FLEET_TYPES.has(s.type as string)) return false
        const sb = editor.getShapePageBounds(s.id)
        return sb && cx >= sb.x && cx <= sb.x + sb.w && cy >= sb.y && cy <= sb.y + sb.h
      })
    }, [editor, shape.id, isAgentPill])

    if (isFileBackedDoc) {
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
            style={{
              width: 300,
              minHeight: 86,
              padding: '10px 12px',
              borderRadius: 6,
              border: `1px solid ${color}55`,
              background: 'rgba(255, 255, 255, 0.96)',
              boxShadow: `0 10px 24px ${color}25`,
              color: '#202124',
              fontSize: 12,
              lineHeight: '17px',
              fontFamily: "'SF Mono', Menlo, Consolas, monospace",
              transform: 'translate(-5px, -5px)',
              userSelect: 'none',
            }}
          >
            <div style={{ color, fontWeight: 600, marginBottom: 6 }}>sticky note</div>
            <div style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {displayName}
            </div>
          </div>
        </HTMLContainer>
      )
    }

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
        {/* Ghost: show where a new chat will be created.
            When expanded (pill is 400×600), the ghost fills the pill bounds.
            When collapsed (pill is 70×18), ghost is offset from pill center.
            Hidden when over an existing fleet shape. */}
        {isAgentPill && !overFleetShape && (
          <div
            className="fleet-chat-shape"
            style={{
              position: 'absolute',
              // When expanded, ghost fills the pill's own bounds (0,0).
              // When collapsed, offset to pill center.
              top: _snapState.expanded ? 0 : PILL_H / 2,
              left: _snapState.expanded ? 0 : PILL_W / 2,
              width: CHAT_W,
              height: CHAT_H,
              opacity: 0.5,
              pointerEvents: 'none',
              display: 'flex',
              flexDirection: 'column',
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
        )}
      </HTMLContainer>
    )
  }

  getIndicatorPath() {
    return undefined
  }

  indicator() {
    return null
  }
}
