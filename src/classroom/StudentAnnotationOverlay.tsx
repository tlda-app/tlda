import { useMemo, useEffect, useState } from 'react'
import { Tldraw, react, type Editor } from 'tldraw'
import { useSync } from '@tldraw/sync'
import { STORE_WS, LICENSE_KEY } from '../activeConfig'
import { appendToken } from '../authToken'
import { createDocumentShapeUtils, INLINE_ASSETS, DOCUMENT_TOOLS } from '../SvgDocument'
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

interface StudentAnnotationOverlayProps {
  /** The room the book itself is synced to — the layer the whole class shares. */
  bookRoomId: string
  /** Whose overlay this is. The teacher names a student to see theirs. */
  studentId: string
  /** The book's editor. Supplies the camera and the current tool. */
  bookEditor: Editor | null
  /** Whether this layer is shown at all. Hiding shows nothing and deletes nothing. */
  visible: boolean
  /** Whether marks land here. Exactly one layer is the write target. */
  isWriteTarget: boolean
  /** This layer's editor, so a move between layers has both stores. */
  onEditorMount?: (editor: Editor | null) => void
}

export function StudentAnnotationOverlay({
  bookRoomId,
  studentId,
  bookEditor,
  visible,
  isWriteTarget,
  onEditorMount,
}: StudentAnnotationOverlayProps) {
  const roomId = studentOverlayRoomId(bookRoomId, studentId)
  const [overlayEditor, setOverlayEditor] = useState<Editor | null>(null)
  const shapeUtils = useMemo(() => createDocumentShapeUtils(), [])
  const tools = useMemo(() => DOCUMENT_TOOLS, [])

  const syncUri = useMemo(() => () => appendToken(`${STORE_WS}/sync/${roomId}`), [roomId])
  const store = useSync({ uri: syncUri, shapeUtils, assets: INLINE_ASSETS })

  // Follow the book's camera, so the layers stay registered with each other. The
  // book owns it: panning is a view operation and belongs to the document, not
  // to whichever layer happens to be the write target.
  useEffect(() => {
    if (!bookEditor || !overlayEditor) return
    return react('mirror book camera onto overlay', () => {
      const camera = bookEditor.getCamera()
      const current = overlayEditor.getCamera()
      if (current.x === camera.x && current.y === camera.y && current.z === camera.z) return
      overlayEditor.setCamera(camera, { immediate: true })
    })
  }, [bookEditor, overlayEditor])

  // Follow the book's tool selection, whatever it is.
  //
  // Skip: "so like in photoshop or whatever, you select any number of layers to
  // be visible and one to be the current write target." The tool never chooses
  // the destination — pen, highlighter and eraser all act on the write target,
  // and this canvas is that target or it is not.
  useEffect(() => {
    if (!bookEditor || !overlayEditor || !isWriteTarget) return
    return react('follow book tool selection', () => {
      const toolId = bookEditor.getCurrentToolId()
      if (overlayEditor.getCurrentToolId() !== toolId) overlayEditor.setCurrentTool(toolId)
    })
  }, [bookEditor, overlayEditor, isWriteTarget])

  useEffect(() => {
    if (!overlayEditor) return
    overlayEditor.updateInstanceState({ isReadonly: !isWriteTarget })
  }, [overlayEditor, isWriteTarget])

  // The store goes to <Tldraw> with its status attached, exactly as the book's
  // editor does — tldraw owns the not-yet-synced state itself.
  //
  // This used to return null until `synced-remote`, which meant a reconnect
  // unmounted the canvas and disposed its editor mid-session. That is the whole
  // cause of the crash on selecting this layer, not a symptom of it: the editor
  // died, the reference to it did not, and the camera reactor kept writing to a
  // corpse. Defending the reactor would have left the layer silently vanishing
  // on every reconnect instead.
  //
  // Kept mounted when hidden, for the same reason: hiding a layer hides it, and
  // a layer torn down and rebuilt on every toggle is a different thing wearing
  // the same name.
  return (
    <div
      className="studentAnnotationOverlay"
      data-capturing={isWriteTarget ? 'true' : 'false'}
      data-visible={visible ? 'true' : 'false'}
    >
      <Tldraw
        store={store}
        shapeUtils={shapeUtils}
        // Every other canvas in this app passes these two and this one did not.
        //
        // `licenseKey`: without it tldraw renders its container and no canvas —
        // a mounted, correctly sized, healthy-store element with nothing inside,
        // which is exactly what a student saw when they selected this layer.
        //
        // `tools`: the design is that the tool never chooses the destination, so
        // whatever the book is in has to exist here too. Without them, following
        // the book into `math-note` or `text-select` addresses a tool this editor
        // has never heard of.
        licenseKey={LICENSE_KEY}
        tools={tools}
        hideUi
        // The teardown half is load-bearing, not tidiness. This canvas unmounts
        // whenever its room's sync status leaves `synced-remote` — a reconnect is
        // enough — and that disposes the editor. Without clearing the reference,
        // the camera reactor below goes on calling `setCamera` on a dead editor,
        // whose `_cameraOptions` is undefined, and the render throws
        // `Cannot read properties of undefined (reading '__unsafe__getWithoutCapture')`,
        // taking the overlay AND the layers control off the page. tldraw runs
        // what `onMount` returns when the editor goes.
        onMount={editor => {
          setOverlayEditor(editor)
          onEditorMount?.(editor)
          return () => { setOverlayEditor(null); onEditorMount?.(null) }
        }}
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
