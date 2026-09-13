import { useCallback, useMemo, useRef, useState } from 'react'
import { useValue, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import { CanvasClipPanel, syncCanvasClipPanelViewportCamera } from '../CanvasClipPanel'
import { getDeviceId } from '../fleet/fleet-data.mjs'
import { useFleetIdentity } from '../fleet-data-adapter'
import { getEditorWMCore } from '../wm/editor-wm'
import { mountGradingPanes, gradingPanelWidth, GRADING_PANE_MAX_HEIGHT_FRACTION, type GradingPane } from './gradingPanes'
import { StudentAnnotationOverlay } from './StudentAnnotationOverlay'
import { gradingDraftRoomId } from '../../shared/classroom-rooms.mjs'

export interface ClassroomGradingSurfaceProps {
  editor: Editor
  assignmentId: string
  problemId: string
  studentId: string
  submissionShapeId: TLShapeId
  solutionShapeId: TLShapeId
  /**
   * The room the submission itself is synced to — the layer the student reads.
   *
   * The private marking layer is named off it, and it is where `Return` moves
   * marks to. Passed in rather than derived here, because the room name comes
   * from the submission's `contentRef` and this component is given ids, not the
   * record.
   */
  submissionRoomId: string
  /**
   * The draft layer's editor, **with the room it belongs to**.
   *
   * The room travels with the editor because the receiver has to be able to
   * tell whether the editor it is holding is still the one for the student it
   * meant to return. Flicking to the next student replaces this layer, and an
   * editor identified only as "the draft editor" would let a return that began
   * on one student finish on another.
   */
  onDraftEditor?: (editor: Editor | null, roomId: string) => void
}

function belongsToPane(editor: Editor, shape: TLShape, paneShapeId: TLShapeId) {
  let current: TLShape | undefined = shape
  while (current) {
    if (current.id === paneShapeId) return true
    if (!String(current.parentId).startsWith('shape:')) return false
    current = editor.getShape(current.parentId as TLShapeId)
  }
  return false
}

export function ClassroomGradingSurface({
  editor,
  assignmentId,
  problemId,
  studentId,
  submissionShapeId,
  solutionShapeId,
  submissionRoomId,
  onDraftEditor,
}: ClassroomGradingSurfaceProps) {
  // The submission pane's own camera. The draft layer is composited over that
  // pane, and the pane is a viewport with its own camera over the shared store,
  // so the main editor's camera would put the marks somewhere else.
  const [submissionCamera, setSubmissionCamera] = useState<{ x: number; y: number; z: number } | null>(null)
  const draftEditorRef = useRef<Editor | null>(null)
  const { id: userId } = useFleetIdentity()
  const deviceId = getDeviceId()
  const wm = useMemo(() => getEditorWMCore(editor), [editor])
  const readyViewports = useRef<Set<GradingPane>>(new Set())
  const mountedPanesRef = useRef<ReturnType<typeof mountGradingPanes> | null>(null)
  const [mountedPanes, setMountedPanes] = useState<ReturnType<typeof mountGradingPanes> | null>(null)

  const submissionBounds = useValue(
    `classroom-submission-bounds:${submissionShapeId}`,
    () => editor.getShapePageBounds(submissionShapeId),
    [editor, submissionShapeId],
  )
  const solutionBounds = useValue(
    `classroom-solution-bounds:${solutionShapeId}`,
    () => editor.getShapePageBounds(solutionShapeId),
    [editor, solutionShapeId],
  )

  const markViewportReady = useCallback((pane: GradingPane, mountedEditor: Editor | null) => {
    if (!mountedEditor) {
      readyViewports.current.delete(pane)
      const mounted = mountedPanesRef.current
      if (!mounted) return
      mountedPanesRef.current = null
      for (const currentPane of mounted) {
        if (wm.hasLayer(currentPane.layerId)) wm.removeLayer(currentPane.layerId)
      }
      setMountedPanes(null)
      return
    }

    readyViewports.current.add(pane)
    if (
      mountedPanesRef.current || readyViewports.current.size !== 2 ||
      !userId || !deviceId || !submissionBounds || !solutionBounds
    ) return

    const panes = mountGradingPanes(wm, editor, {
      'official-solution': solutionBounds,
      'student-submission': submissionBounds,
    }, {
      assignmentId,
      problemId,
      studentId,
      owner: { userId, deviceId },
      source: 'classroom-marking',
    }, {
      // Built here rather than closed over from the render body: it is
      // recomputed every render, so a shared object could not go in this
      // effect's deps without remounting the panes continuously.
      panelWidth: gradingPanelWidth(),
      viewportHeight: window.innerHeight,
      maxHeightFraction: GRADING_PANE_MAX_HEIGHT_FRACTION,
    })
    mountedPanesRef.current = panes
    setMountedPanes(panes)
  }, [assignmentId, deviceId, editor, problemId, solutionBounds, studentId, submissionBounds, userId, wm])
  const markSolutionViewportReady = useCallback(
    (mountedEditor: Editor | null) => markViewportReady('official-solution', mountedEditor),
    [markViewportReady],
  )
  const markSubmissionViewportReady = useCallback(
    (mountedEditor: Editor | null) => markViewportReady('student-submission', mountedEditor),
    [markViewportReady],
  )

  if (!submissionBounds || !solutionBounds) return null

  const activePanes = userId && deviceId ? mountedPanes : null
  const paneByKind = new Map(activePanes?.map(pane => [pane.pane, pane]))
  // The DOM's copy of the pane width, from the same derivation the cameras use.
  const panelWidth = gradingPanelWidth()

  return (
    <div className="classroomGradingPanes" data-classroom-wm-mounted={activePanes ? 'true' : 'false'}>
      {([
        ['official-solution', solutionShapeId, solutionBounds],
        ['student-submission', submissionShapeId, submissionBounds],
      ] as const).map(([pane, shapeId, bounds]) => {
        const mounted = paneByKind.get(pane)
        // One expression for the pane's viewport id, because the overlay has to
        // name the SAME viewport the panel registered — two spellings that agree
        // today are two that disagree after a rename, and the disagreement shows
        // up as a layer that silently stops following its pane.
        const paneViewportId = (kind: GradingPane) =>
          paneByKind.get(kind)?.viewportId ?? `wm:grading:${kind}:${assignmentId}:${studentId}`
        return (
          <section key={pane} className="classroomGradingPane" data-grading-pane={pane}>
            <CanvasClipPanel
              mainEditor={editor}
              bounds={bounds}
              panelWidth={panelWidth}
              maxHeightFraction={GRADING_PANE_MAX_HEIGHT_FRACTION}
              viewportId={paneViewportId(pane)}
              wmSurface={mounted?.wmSurface}
              interactionMode="pinned"
              unboundedPanning
              shapePredicate={shape => belongsToPane(editor, shape, shapeId)}
              onEditorMount={pane === 'official-solution' ? markSolutionViewportReady : markSubmissionViewportReady}
              onCamera={pane === 'student-submission' ? setSubmissionCamera : undefined}
              canvasOverlay={pane === 'student-submission' && submissionCamera ? (
                // The instructor's private marking layer, over the student's
                // work and nothing else.
                //
                // Only this pane. A mark on his own solution is the common
                // layer — written once for the class — and was never this
                // student's feedback, so the solution pane keeps writing where
                // it always did.
                //
                // Always the write target: there is no layer menu on this screen,
                // and the alternative is marks landing in the room the student
                // reads, which is the defect being fixed.
                //
                // Being the write target is not the same as taking every
                // pointer. The layer captures only while a mark-making tool is
                // active — `markingCapture.ts` — so pointer, selection, scroll
                // and pan reach the pane underneath the rest of the time. Skip
                // settled that: capture while drawing, otherwise pass through.
                <StudentAnnotationOverlay
                  bookRoomId={submissionRoomId}
                  studentId={studentId}
                  bookEditor={editor}
                  visible
                  isWriteTarget
                  roomId={gradingDraftRoomId(submissionRoomId)}
                  camera={submissionCamera}
                  // A gesture taken by this layer drives the PANE, never the
                  // main editor: the panes are derived from that editor, so
                  // writing it would move both of them and feed back here.
                  onCameraChange={nextCamera => {
                    syncCanvasClipPanelViewportCamera(paneViewportId('student-submission'), nextCamera)
                  }}
                  onEditorMount={draftEditor => {
                    draftEditorRef.current = draftEditor
                    onDraftEditor?.(draftEditor, submissionRoomId)
                  }}
                  onEditorRelease={draftEditor => {
                    // Only if it is still the one we hold: a remount can release
                    // the old editor after the replacement registered, and an
                    // unconditional clear would drop the live one.
                    if (draftEditorRef.current !== draftEditor) return
                    draftEditorRef.current = null
                    onDraftEditor?.(null, submissionRoomId)
                  }}
                />
              ) : undefined}
            />
          </section>
        )
      })}
    </div>
  )
}
