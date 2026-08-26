import { useMemo, useEffect, useState, useRef } from 'react'
import { Tldraw, react, type Editor } from 'tldraw'
import { useSync } from '@tldraw/sync'
import { STORE_WS } from '../activeConfig'
import { appendToken } from '../authToken'
import { createDocumentShapeUtils, INLINE_ASSETS } from '../SvgDocument'
import { studentOverlayRoomId } from './studentOverlayRoom'
import './StudentAnnotationOverlay.css'

// A student's own annotation layer, over the book.
//
// Skip, 9 August, on whether a shared "common annotation layer" was a thing to
// build: "maybe that just is the normal layer... the normal layer for the book."
// And: "each student can experience their class layer as, like, an overlay on
// that."
//
// So this builds only the second half. The book's own sync room already IS the
// layer the whole class sees — BookViewer gives each member doc its own room —
// and nothing here creates, mirrors, or reconciles it. What is new is one more
// canvas above it, on a room only this student writes.
//
// Two canvases, not one store with two scopes: the point of a private overlay is
// that its state is NOT shared, and the window manager's layers are coordinate
// spaces over a single editor (`packages/tldraw-wm/src/wm-core.ts:54` — every
// LayerBacking arm is frame/screen/page/viewport). Compositing separate stores is
// a DOM job, and this is the DOM job.
//
// This canvas holds annotations only. It never renders the book: page shapes are
// created into whichever room an SvgDocumentEditor is pointed at
// (`src/loaders/createShapes.ts`), so putting a document editor here would put a
// second copy of the book in the student's room rather than a transparent sheet
// over the first.

// Tools whose gestures make or remove marks. While one of these is selected the
// overlay takes pointer input, so the stroke lands in the student's room. Under
// every other tool the overlay is inert and the book beneath is fully live —
// text selection, the reading tools and panning all keep working, which they
// would not if a transparent canvas sat over the book catching everything.
const MARK_MAKING_TOOLS = new Set(['draw', 'highlight', 'eraser', 'math-note', 'voice-note'])

interface StudentAnnotationOverlayProps {
  /** The room the book itself is synced to — the layer the whole class shares. */
  bookRoomId: string
  /** Whose overlay to show. The teacher passes a student's id to read theirs. */
  studentId: string
  /** The book's editor. Supplies the camera and the current tool. */
  bookEditor: Editor | null
  /** True when this overlay may be drawn on — false when reading someone else's. */
  writable?: boolean
}

export function StudentAnnotationOverlay({
  bookRoomId,
  studentId,
  bookEditor,
  writable = true,
}: StudentAnnotationOverlayProps) {
  const roomId = studentOverlayRoomId(bookRoomId, studentId)
  const [overlayEditor, setOverlayEditor] = useState<Editor | null>(null)
  const shapeUtils = useMemo(() => createDocumentShapeUtils(), [])
  const [capturing, setCapturing] = useState(false)
  // The tool the overlay should be in. Kept out of state deliberately: it is
  // read inside the camera reaction, and a re-render per tool change would
  // remount nothing useful.
  const toolRef = useRef('select')

  const syncUri = useMemo(() => () => appendToken(`${STORE_WS}/sync/${roomId}`), [roomId])
  const store = useSync({ uri: syncUri, shapeUtils, assets: INLINE_ASSETS })

  // Follow the book's camera. The book owns it — panning and zooming happen down
  // there, because this canvas only takes input while a mark-making tool is
  // active and no panning happens under those.
  useEffect(() => {
    if (!bookEditor || !overlayEditor) return
    return react('mirror book camera onto overlay', () => {
      const camera = bookEditor.getCamera()
      const current = overlayEditor.getCamera()
      if (current.x === camera.x && current.y === camera.y && current.z === camera.z) return
      overlayEditor.setCamera(camera, { immediate: true })
    })
  }, [bookEditor, overlayEditor])

  // Follow the book's tool selection, and take pointer input only for the tools
  // that make marks. The student picks a tool on the book's own toolbar; this
  // decides where the resulting gesture lands.
  useEffect(() => {
    if (!bookEditor) return
    return react('follow book tool selection', () => {
      const toolId = bookEditor.getCurrentToolId()
      toolRef.current = toolId
      setCapturing(writable && MARK_MAKING_TOOLS.has(toolId))
    })
  }, [bookEditor, writable])

  useEffect(() => {
    if (!overlayEditor || !capturing) return
    if (overlayEditor.getCurrentToolId() !== toolRef.current) overlayEditor.setCurrentTool(toolRef.current)
  }, [overlayEditor, capturing])

  useEffect(() => {
    if (!overlayEditor) return
    overlayEditor.updateInstanceState({ isReadonly: !writable })
  }, [overlayEditor, writable])

  if (store.status !== 'synced-remote') return null

  return (
    <div
      className="studentAnnotationOverlay"
      data-capturing={capturing ? 'true' : 'false'}
    >
      <Tldraw
        store={store}
        shapeUtils={shapeUtils}
        hideUi
        onMount={setOverlayEditor}
        components={OVERLAY_COMPONENTS}
      />
    </div>
  )
}

// The overlay is a sheet of marks over someone else's canvas: no background to
// paint over the book, and no grid, scribble or handle chrome of its own.
const OVERLAY_COMPONENTS = {
  Background: null,
  Grid: null,
  PageMenu: null,
  NavigationPanel: null,
  Toolbar: null,
  StylePanel: null,
  ContextMenu: null,
  HelpMenu: null,
  MainMenu: null,
  ActionsMenu: null,
  ZoomMenu: null,
  QuickActions: null,
  DebugPanel: null,
  DebugMenu: null,
  SharePanel: null,
  MenuPanel: null,
  TopPanel: null,
  CursorChatBubble: null,
}
