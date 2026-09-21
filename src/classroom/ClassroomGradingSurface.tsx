import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useValue, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import { CanvasClipPanel } from '../CanvasClipPanel'
import { getDeviceId } from '../fleet/fleet-data.mjs'
import { useFleetIdentity } from '../fleet-data-adapter'
import { getEditorWMCore } from '../wm/editor-wm'
import { mountGradingPanes, gradingPanelWidth, GRADING_PANE_MAX_HEIGHT_FRACTION, type GradingPane } from './gradingPanes'
import { useContentAnchoredMarks } from './useContentAnchoredMarks'
import { gradingPanePanInteraction, isWorkspaceMarkingInput, isWorkspaceSubmissionShape, isStampedMarkingShapeType, markingTag, shapeBelongsToMarkingLayer } from './gradingWorkspace'

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
}: ClassroomGradingSurfaceProps) {
  // The identity this answer's marks carry. The editor is already the private
  // workspace room; this names which answer a shape in it belongs to.
  const identity = useMemo(() => ({
    assignmentId,
    studentId,
    problemId,
    submissionRoomId,
  }), [assignmentId, studentId, problemId, submissionRoomId])
  const getShape = useCallback((id: string) => editor.getShape(id as TLShapeId) as TLShape | undefined, [editor])
  const currentToolId = useValue(
    'classroom-grading-tool',
    () => editor.getCurrentToolId(),
    [editor],
  )
  // The private workspace has one writable viewport: the submission pane.
  // Therefore every mark-tool shape created in this store belongs to this
  // answer, including shapes created asynchronously after pointer-up and voice
  // notes created immediately on tool entry.
  const isMarkingInput = useCallback(
    () => isWorkspaceMarkingInput(editor.getCurrentToolId()),
    [editor],
  )
  // The source page and the mark live in the same private store, so anchoring
  // reads and writes through one editor.
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
  const submissionPaneRef = useRef<HTMLElement | null>(null)
  useContentAnchoredMarks(editor, editor, {
    anchorOnCreate: true,
    pageShapeId: submissionShapeId,
    governingRoot: () => submissionPaneRef.current,
    marking: {
      identity,
      tag: markingTag,
      isStampedType: isStampedMarkingShapeType,
      isMarkingInput,
    },
  })
  const { id: userId } = useFleetIdentity()
  const deviceId = getDeviceId()
  const wm = useMemo(() => getEditorWMCore(editor), [editor])
  // The submission pane's own camera. The pane is a viewport with its own
  // camera over the shared store, so the main editor's camera would put the
  // marks somewhere else.
  const [submissionCamera, setSubmissionCamera] = useState<{ x: number; y: number; z: number } | null>(null)
  const readyViewports = useRef<Set<GradingPane>>(new Set())
  const mountedPanesRef = useRef<ReturnType<typeof mountGradingPanes> | null>(null)
  const [mountedPanes, setMountedPanes] = useState<ReturnType<typeof mountGradingPanes> | null>(null)
  const [problemTop, setProblemTop] = useState<number | null>(null)
  const [paired, setPaired] = useState(false)

  useEffect(() => {
    setSubmissionCamera(null)
  }, [problemId, studentId])

  // Eraser and selection must not reach outside this answer's marking layer:
  // the workspace holds the solution page and both locked source pages, and a
  // drag-select or eraser stroke is evaluated by the shared editor against the
  // whole store. Deletions are vetoed for anything that is not a shape in this
  // answer's marking layer — including the submitted page and its content
  // descendants, which the instructor marks on but never erases. The veto is
  // deliberately delete-only: moves and reshapes of source pages keep their
  // existing owners elsewhere.
  useEffect(() => {
    const allowed = (id: string) => {
      const shape = editor.getShape(id as TLShapeId) as TLShape | undefined
      if (!shape) return false
      return (
        shapeBelongsToMarkingLayer(id, getShape, identity) &&
        !belongsToPane(editor, shape, submissionShapeId) &&
        !belongsToPane(editor, shape, solutionShapeId)
      )
    }
    return editor.sideEffects.registerBeforeDeleteHandler('shape', (shape: any) => {
      if (allowed(String(shape.id))) return
      return false
    })
  }, [editor, getShape, identity, solutionShapeId, submissionShapeId])

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
        // One expression for the pane's viewport id, because the panes below
        // have to name the SAME viewport the panel registered — two spellings
        // that agree today are two that disagree after a rename, and the
        // disagreement shows up as a layer that silently stops following its
        // pane.
        const paneViewportId = (kind: GradingPane) =>
          paneByKind.get(kind)?.viewportId ?? `wm:grading:${kind}:${assignmentId}:${studentId}`
        const isSubmission = pane === 'student-submission'
        return (
          <section
            key={pane}
            className="classroomGradingPane"
            data-grading-pane={pane}
            ref={isSubmission
              ? (node => { submissionPaneRef.current = node })
              : undefined}
            onWheelCapture={isSubmission ? event => {
              // While a mark-making tool is active the pane routes input to the
              // shared editor, and the wheel capture below would pan the pane
              // camera mid-stroke. Pass through so draw input owns the gesture.
              if (isWorkspaceMarkingInput(editor.getCurrentToolId())) return
              event.stopPropagation()
              setSubmissionCamera(camera => camera ? {
                ...camera,
                x: camera.x - event.deltaX / camera.z,
                y: camera.y - event.deltaY / camera.z,
              } : camera)
            } : undefined}
          >
            <CanvasClipPanel
              mainEditor={editor}
              bounds={bounds}
              panelWidth={panelWidth}
              maxHeightFraction={GRADING_PANE_MAX_HEIGHT_FRACTION}
              viewportId={paneViewportId(pane)}
              wmSurface={mounted?.wmSurface}
              interactionMode="pinned"
              // The submission pane takes draw input over the shared editor; the
              // solution pane keeps writing where it always did (the common
              // layer, never this student's feedback). `readOnly` is false only
              // on the submission pane, and the explicit predicate below still
              // filters its rendering set either way.
              readOnly={!isSubmission}
              // CanvasClipPanel's pan layer owns primary pointers while active.
              // Disable it for mark-making tools so TldrawViewport receives the
              // stroke; restore it for selection and ordinary pane navigation.
              panInteraction={gradingPanePanInteraction(isSubmission, currentToolId)}
              unboundedPanning
              requestedShapeIds={[shapeId]}
              shapePredicate={shape => isSubmission
                ? isWorkspaceSubmissionShape(shape, getShape, submissionShapeId, identity)
                : belongsToPane(editor, shape, shapeId)}
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
              onCamera={isSubmission ? setSubmissionCamera : undefined}
              cameraOverride={isSubmission ? (submissionCamera ?? problemCamera) : null}
            />
          </section>
        )
      })}
    </div>
  )
}
