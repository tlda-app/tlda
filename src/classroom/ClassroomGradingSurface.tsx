import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useValue, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import { CanvasClipPanel, syncCanvasClipPanelViewportCamera } from '../CanvasClipPanel'
import { getDeviceId } from '../fleet/fleet-data.mjs'
import { useFleetIdentity } from '../fleet-data-adapter'
import { getEditorWMCore } from '../wm/editor-wm'
import { mountGradingPanes, gradingPanelWidth, GRADING_PANE_MAX_HEIGHT_FRACTION, type GradingPane } from './gradingPanes'
import { StudentAnnotationOverlay } from './StudentAnnotationOverlay'
import { useContentAnchoredMarks } from './useContentAnchoredMarks'
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
  // The same editor as the ref, in state, because anchoring is an effect and an
  // effect cannot see a ref being assigned. The ref stays the identity the
  // release guard above compares against.
  const [anchoringEditor, setAnchoringEditor] = useState<Editor | null>(null)
  const { id: userId } = useFleetIdentity()
  const deviceId = getDeviceId()
  const wm = useMemo(() => getEditorWMCore(editor), [editor])
  // Bound by the student-submission <section> below; declared before the hook
  // that reads it.
  const submissionPaneRef = useRef<HTMLElement | null>(null)
  // A mark belongs to the student's work, not to the page it happens to sit on.
  // This is the side that MAKES marks, so it is the side that records an anchor.
  //
  // The submission page mounts once per pane and once in the main editor, and
  // those copies disagree about which solutions are open. A mark has one opacity,
  // so one view has to govern — and it is this one: the pane the instructor marks
  // in. Named here rather than guessed inside `anchorContexts`, which has no
  // business knowing what a grading pane is.
  //
  // THIS instance's pane, held as a ref, not found by a global selector: a
  // document-wide query would answer with some other surface's pane if two were
  // ever mounted, and would silently pick one of them.
  useContentAnchoredMarks(editor, anchoringEditor, {
    anchorOnCreate: true,
    pageShapeId: submissionShapeId,
    governingRoot: () => submissionPaneRef.current,
  })
  const readyViewports = useRef<Set<GradingPane>>(new Set())
  const mountedPanesRef = useRef<ReturnType<typeof mountGradingPanes> | null>(null)
  const [mountedPanes, setMountedPanes] = useState<ReturnType<typeof mountGradingPanes> | null>(null)
  const [problemTop, setProblemTop] = useState<number | null>(null)
  const [paired, setPaired] = useState(false)

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

  // The pane's width has to agree with the column it sits in. `gradingPanelWidth`
  // is half the window, which is right for the two-pane layout; the paired layout
  // is one column, so the pane is the full inset width.
  //
  // `37eb2e3b0` made that change alongside the single-column CSS. Main has since
  // refactored its literal into `gradingPanelWidth()`, which still returns the
  // two-column half, so carrying the CSS without this restores the layout but not
  // the width it was written for.
  useEffect(() => {
    const read = () => setPaired(window.document.body.dataset.tldaMarkedExercisePaired === 'true')
    read()
    const observer = new MutationObserver(read)
    observer.observe(window.document.body, { attributes: true, attributeFilter: ['data-tlda-marked-exercise-paired'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setProblemTop(null)
    let interval = 0
    const findProblem = () => {
      const target = Array.from(window.document.querySelectorAll<HTMLIFrameElement>(`[data-shape-id="${submissionShapeId}"] iframe`))
        .map(frame => frame.contentDocument?.getElementById(problemId))
        .find((candidate): candidate is HTMLElement => !!candidate)
      if (!target) return
      setProblemTop(target.getBoundingClientRect().top)
      window.clearInterval(interval)
    }
    interval = window.setInterval(findProblem, 250)
    findProblem()
    return () => window.clearInterval(interval)
  }, [problemId, submissionShapeId])

  if (!submissionBounds || !solutionBounds) return null

  const activePanes = userId && deviceId ? mountedPanes : null
  const paneByKind = new Map(activePanes?.map(pane => [pane.pane, pane]))
  // The DOM's copy of the pane width, from the same derivation the cameras use.
  const panelWidth = paired ? Math.max(320, Math.floor(window.innerWidth - 32)) : gradingPanelWidth()

  const problemCamera = problemTop == null ? null : {
    x: -submissionBounds.x,
    y: -(submissionBounds.y + problemTop - 80 / (panelWidth / submissionBounds.w)),
    z: panelWidth / submissionBounds.w,
  }

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
          <section
            key={pane}
            className="classroomGradingPane"
            data-grading-pane={pane}
            ref={pane === 'student-submission'
              ? (node => { submissionPaneRef.current = node })
              : undefined}
          >
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
              // Keep this pane's document and its iframe mounted while the
              // measured size arrives.
              //
              // `canCull` keeps a shape mounted within three of its OWN heights
              // of the camera, so a shape still carrying the height the build
              // declared has a margin sized by that declared height. A pane
              // aimed further down the document than that margin reaches culls
              // it — and a culled shape has no iframe, so the measured height
              // that would widen the margin never arrives.
              //
              // `disableCulling` covers both: tldraw stops culling the shape,
              // and `VisibilityViewportProvider` keeps its iframe mounted.
              disableCulling

              onEditorMount={pane === 'official-solution' ? markSolutionViewportReady : markSubmissionViewportReady}
              onCamera={pane === 'student-submission' ? setSubmissionCamera : undefined}
              cameraOverride={pane === 'student-submission' ? problemCamera : null}
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
                    setAnchoringEditor(draftEditor)
                    onDraftEditor?.(draftEditor, submissionRoomId)
                  }}
                  onEditorRelease={draftEditor => {
                    // Only if it is still the one we hold: a remount can release
                    // the old editor after the replacement registered, and an
                    // unconditional clear would drop the live one.
                    if (draftEditorRef.current !== draftEditor) return
                    draftEditorRef.current = null
                    setAnchoringEditor(current => (current === draftEditor ? null : current))
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
