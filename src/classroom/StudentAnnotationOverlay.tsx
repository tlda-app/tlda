import { useMemo, useEffect, useState } from 'react'
import { Tldraw, react, useValue, type Editor } from 'tldraw'
import { useSync } from '@tldraw/sync'
import { STORE_WS, LICENSE_KEY } from '../activeConfig'
import { appendToken } from '../authToken'
import { createDocumentShapeUtils, INLINE_ASSETS, DOCUMENT_TOOLS } from '../SvgDocument'
import { studentOverlayRoomId } from './studentOverlayRoom'
import { markingLayerCaptures } from './markingCapture'
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

/**
 * Observe one editor and write to another, without the write landing inside the
 * observation.
 *
 * A `react()` whose function writes to what it also reads can be walked while it
 * is still capturing. `@tldraw/state`'s `startCapturingParents` clears the
 * parent SET but leaves `child.parents` holding the previous run's entries —
 * only `stopCapturingParents` truncates it — so for the whole duration of a
 * reaction that array is half-updated. A write opens a transaction, the commit
 * flushes the scheduler, the scheduler walks reactors, and `haveParentsChanged`
 * dereferences a slot that is in flux:
 *
 *   TypeError: Cannot read properties of undefined
 *              (reading '__unsafe__getWithoutCapture')
 *
 * It reads as a destroyed editor and is not. `Editor._cameraOptions` is a class
 * field, never reassigned and never deleted, so a disposed editor still has one;
 * the `undefined` is an entry in a reactor's parent list.
 *
 * The rule this encodes: **observe the source, never the sink.** `observe` is
 * the only thing captured, and the write is deferred past the end of the
 * reaction, where reads capture nothing because no frame is on the stack.
 *
 * Measured 2026-08-27: two reactors here had the read-then-write shape and only
 * one of them ever threw. Having the shape and not firing is not the same as
 * being safe — the quiet one is the same defect waiting on a different flush —
 * so both go through here.
 */
function mirror(name: string, observe: () => unknown, write: () => void): () => void {
  let queued = false
  let stopped = false
  const stop = react(name, () => {
    observe()
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      // The reactor may have been torn down between queueing and running.
      if (!stopped) write()
    })
  })
  return () => { stopped = true; stop() }
}


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
  onEditorMount?: (editor: Editor) => void
  /**
   * This canvas's editor is going. It is passed rather than implied, because the
   * receiver has to be able to tell whether the editor it holds is this one — a
   * remount can run this teardown after the replacement has already registered,
   * and an unconditional release would drop the live editor.
   */
  onEditorRelease?: (editor: Editor) => void
  /**
   * Which room this layer syncs, when it is not a student's own overlay.
   *
   * The marking surface composites an instructor's private `grading-draft`
   * layer, which hangs off a submission rather than off a student. Same canvas,
   * same capture and camera behavior, different room — so this overrides the
   * name rather than duplicating the component. Absent, the room is
   * `studentOverlayRoomId(bookRoomId, studentId)` exactly as before.
   */
  roomId?: string
  /**
   * The camera to follow, when the surface underneath is not `bookEditor`'s.
   *
   * Over the book, the book's editor owns the camera and this layer mirrors it.
   * Over a grading pane the surface underneath is a viewport with its own
   * camera over a shared store, so `bookEditor.getCamera()` is the wrong one and
   * marks would land offset from the work they annotate. Absent, the mirror
   * behaves exactly as before.
   */
  camera?: { x: number; y: number; z: number }
  /**
   * Where a gesture this layer swallowed should go, in explicit-camera mode.
   *
   * Over the book, the effect below carries the camera back into `bookEditor`,
   * because the book owns it. Over a grading pane it must not: `bookEditor`
   * there is the main document editor the panes are *derived from*, so writing
   * the pane's camera into it moves both panes and feeds back. The receiver
   * hands the camera to the pane's own viewport instead.
   */
  onCameraChange?: (camera: { x: number; y: number; z: number }) => void
}

export function StudentAnnotationOverlay({
  bookRoomId,
  studentId,
  bookEditor,
  visible,
  isWriteTarget,
  onEditorMount,
  onEditorRelease,
  roomId: explicitRoomId,
  camera: explicitCamera,
  onCameraChange,
}: StudentAnnotationOverlayProps) {
  // Whether the camera is owned outside this component. A boolean, not the
  // camera itself, so the effects below do not resubscribe on every pan.
  const cameraIsExternal = explicitCamera !== undefined

  // Capture only while drawing.
  //
  // Skip, asked whether the marking layer should take every pointer or only the
  // marking ones: "yea" — capture while drawing, otherwise let pointer,
  // selection and scroll reach the surface underneath. And on the risk of
  // getting the boundary wrong: "if we sont like it we'll change it."
  //
  const currentToolId = useValue('overlay tool', () => bookEditor?.getCurrentToolId() ?? 'select', [bookEditor])
  const capturing = cameraIsExternal
    // Composited over a pane: the pane is a live surface with its own pan, zoom,
    // text selection and page interaction, and swallowing those would leave it
    // frozen under a layer that only wanted the pen.
    ? isWriteTarget && markingLayerCaptures(currentToolId)
    // Over the book, unchanged: the write target captures, and the effect that
    // carries gestures back to the book is what keeps the book usable.
    : isWriteTarget
  const roomId = explicitRoomId ?? studentOverlayRoomId(bookRoomId, studentId)
  const [overlayEditor, setOverlayEditor] = useState<Editor | null>(null)
  const shapeUtils = useMemo(() => createDocumentShapeUtils(), [])
  const tools = useMemo(() => DOCUMENT_TOOLS, [])

  const syncUri = useMemo(() => () => appendToken(`${STORE_WS}/sync/${roomId}`), [roomId])
  const store = useSync({ uri: syncUri, shapeUtils, assets: INLINE_ASSETS })

  // Follow the book's camera, so the layers stay registered with each other. The
  // book owns it: panning is a view operation and belongs to the document, not
  // to whichever layer happens to be the write target.
  useEffect(() => {
    // An explicit camera means the surface underneath is not `bookEditor` — a
    // grading pane owns its own. Mirroring the book's camera here as well would
    // fight the effect below and leave the layer wherever the last writer put
    // it, so the mirror stands down rather than both of them writing.
    if (explicitCamera || !bookEditor || !overlayEditor) return
    return mirror('mirror book camera onto overlay', () => bookEditor.getCamera(), () => {
      const camera = bookEditor.getCamera()
      const current = overlayEditor.getCamera()
      if (current.x === camera.x && current.y === camera.y && current.z === camera.z) return
      overlayEditor.setCamera(camera, { immediate: true })
    })
  }, [bookEditor, overlayEditor, explicitCamera])

  // Follow the surface's own camera, when one is handed in. Same comparison as
  // the mirror above — write only on an actual change — because `setCamera` on
  // every render is what makes a composited layer stutter.
  useEffect(() => {
    if (!explicitCamera || !overlayEditor) return
    const current = overlayEditor.getCamera()
    if (current.x === explicitCamera.x && current.y === explicitCamera.y && current.z === explicitCamera.z) return
    overlayEditor.setCamera(explicitCamera, { immediate: true })
  }, [overlayEditor, explicitCamera])

  // Give the book back the gestures this layer swallowed.
  //
  // The comment above says the book owns panning, and it does -- but while this
  // layer is the write target the CSS flips it to `pointer-events: auto` over
  // `inset: 0`, so every pointer in the viewport lands here and the book never
  // sees the pinch at all. Its own camera then loses the change to the mirror
  // above, which writes the book's camera back over it. The result is a surface
  // that draws but cannot zoom, pan or take a second finger, while every piece
  // of it is individually correct -- which is why it survived.
  //
  // tldraw already turned the gesture into a camera on this editor, so the fix
  // is to carry that to the book rather than to re-derive pinch arithmetic here.
  // Only the write target does it: it is the only layer taking pointer input, so
  // it is the only one with a gesture to forward, and the book stays the single
  // owner every other layer mirrors from.
  //
  // The two mirrors do not chase each other: each compares before it writes and
  // returns when the cameras already agree, so the pair settles after one pass.
  useEffect(() => {
    // Stands down when the camera is owned outside: `bookEditor` is then the
    // editor the surface underneath is DERIVED from, not the surface itself, so
    // writing to it would move every view built on it and feed back into this
    // layer through the inbound effect. The gesture goes to `onCameraChange`
    // instead — see the effect below.
    if (cameraIsExternal || !bookEditor || !overlayEditor || !isWriteTarget) return
    return mirror('carry overlay camera back to book', () => overlayEditor.getCamera(), () => {
      const camera = overlayEditor.getCamera()
      const current = bookEditor.getCamera()
      if (current.x === camera.x && current.y === camera.y && current.z === camera.z) return
      bookEditor.setCamera(camera, { immediate: true })
    })
  }, [bookEditor, overlayEditor, isWriteTarget, cameraIsExternal])

  // Explicit-camera mode: carry the gesture to whoever owns the camera.
  //
  // Same reasoning as the book case — tldraw has already turned the gesture
  // into a camera on this editor, so it is carried rather than re-derived — only
  // the destination differs. The receiver decides what that camera means; this
  // layer never writes the main editor.
  useEffect(() => {
    if (!cameraIsExternal || !overlayEditor || !isWriteTarget || !onCameraChange) return
    return mirror('carry overlay camera to the owning surface', () => overlayEditor.getCamera(), () => {
      onCameraChange(overlayEditor.getCamera())
    })
  }, [cameraIsExternal, overlayEditor, isWriteTarget, onCameraChange])

  // Follow the book's tool selection, whatever it is.
  //
  // Skip: "so like in photoshop or whatever, you select any number of layers to
  // be visible and one to be the current write target." The tool never chooses
  // the destination — pen, highlighter and eraser all act on the write target,
  // and this canvas is that target or it is not.
  useEffect(() => {
    if (!bookEditor || !overlayEditor || !isWriteTarget) return
    return mirror('follow book tool selection', () => bookEditor.getCurrentToolId(), () => {
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
  // This used to return null until `synced-remote`, so a reconnect unmounted the
  // canvas and rebuilt it mid-session. That is worth not doing on its own —
  // a layer that vanishes and re-syncs whenever the socket blinks is not a layer
  // — but it was NOT the cause of the crash on selecting this layer. That was
  // the read-then-write reactor shape described above, and disposal had nothing
  // to do with it.
  //
  // Kept mounted when hidden for the same reason: hiding a layer hides it, and a
  // layer torn down and rebuilt on every toggle is a different thing wearing the
  // same name.
  return (
    <div
      className="studentAnnotationOverlay"
      data-capturing={capturing ? 'true' : 'false'}
      data-tool={currentToolId}
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
        // tldraw runs what `onMount` returns when the editor goes, so the
        // teardown is where the reference is dropped. Nothing may hold a
        // disposed editor — not this component and not BookViewer above it.
        //
        // This is hygiene, not a crash fix. It was written believing a retained
        // dead editor caused the throw on selecting this layer; it did not. See
        // `mirror` above for what did.
        onMount={editor => {
          setOverlayEditor(editor)
          onEditorMount?.(editor)
          return () => { setOverlayEditor(null); onEditorRelease?.(editor) }
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
