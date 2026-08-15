import { useCallback, useMemo, useRef, useState } from 'react'
import { useValue, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import { CanvasClipPanel } from '../CanvasClipPanel'
import { getDeviceId } from '../fleet/fleet-data.mjs'
import { useFleetIdentity } from '../fleet-data-adapter'
import { getEditorWMCore } from '../wm/editor-wm'
import { mountGradingPanes, type GradingPane } from './gradingPanes'

export interface ClassroomGradingSurfaceProps {
  editor: Editor
  assignmentId: string
  problemId: string
  studentId: string
  submissionShapeId: TLShapeId
  solutionShapeId: TLShapeId
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
}: ClassroomGradingSurfaceProps) {
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
  const panelWidth = Math.max(320, Math.floor((window.innerWidth - 48) / 2))

  return (
    <div className="classroomGradingPanes" data-classroom-wm-mounted={activePanes ? 'true' : 'false'}>
      {([
        ['official-solution', solutionShapeId, solutionBounds],
        ['student-submission', submissionShapeId, submissionBounds],
      ] as const).map(([pane, shapeId, bounds]) => {
        const mounted = paneByKind.get(pane)
        return (
          <section key={pane} className="classroomGradingPane" data-grading-pane={pane}>
            <CanvasClipPanel
              mainEditor={editor}
              bounds={bounds}
              panelWidth={panelWidth}
              maxHeightFraction={0.88}
              viewportId={mounted?.viewportId ?? `wm:grading:${pane}:${assignmentId}:${studentId}`}
              wmSurface={mounted?.wmSurface}
              interactionMode="pinned"
              unboundedPanning
              shapePredicate={shape => belongsToPane(editor, shape, shapeId)}
              onEditorMount={pane === 'official-solution' ? markSolutionViewportReady : markSubmissionViewportReady}
            />
          </section>
        )
      })}
    </div>
  )
}
