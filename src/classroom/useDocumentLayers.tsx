import { useCallback, useEffect, useMemo, useState } from 'react'
import { createShapeId, react } from 'tldraw'
import type { Editor } from 'tldraw'
import { StudentAnnotationOverlay } from './StudentAnnotationOverlay'
import { classroomApi, type ClassroomIdentity, type StatusRow } from './api'
import {
  readerLayers,
  studentLayers,
  teacherLayers,
  setLayerVisible,
  setWriteTarget,
  type BookLayerState,
  type BookLayerId,
} from './bookLayers'
import { moveShapesToLayer, copyShapesToLayer, layerStore, layerFrameConversion } from './moveBetweenLayers'
import { getEditorWMCore } from '../wm/editor-wm'
import { ensureClassroomLayer } from '../wm/classroom-layers'
import type { LayersValue } from './layersContext'

/**
 * A reader's layers over one document: the state, the overlay rooms that hold
 * them, and the two operations on a selection.
 *
 * This was inline in `BookViewer`, which is why the layers control could only
 * appear inside a book. Nothing in it is about books — it needs the document's
 * room, the editor drawing it, and who is reading. So it moved out whole, and
 * the two surfaces that render a document both call it.
 *
 * `resetKey` is what the overlays are keyed on. A book switching chapters must
 * tear its overlay rooms down and open the new document's; a standalone document
 * never changes underneath itself and passes nothing.
 */
export function useDocumentLayers({
  roomId,
  documentEditor,
  resetKey = '',
}: {
  roomId: string
  documentEditor: Editor | null
  resetKey?: string
}) {
  const [identity, setIdentity] = useState<ClassroomIdentity | null>(null)
  // Starts at the one layer every reader has. What else they have depends on
  // identity, and identity is asked for asynchronously, so this is the state
  // before the answer arrives rather than a guess at it.
  const [layers, setLayers] = useState<BookLayerState>(readerLayers)
  const [classroomRoster, setClassroomRoster] = useState<StatusRow[]>([])
  const [overlayEditors, setOverlayEditors] = useState<Map<BookLayerId, Editor>>(new Map())
  const [trackedSelectionCount, setTrackedSelectionCount] = useState(0)
  const [moveError, setMoveError] = useState('')

  // Identity follows the CREDENTIAL, not a query parameter: an instructor
  // authenticates with the RW bearer token and never carries a classroom one.
  // 401 is an ordinary reader, and the catch leaves them an ordinary document.
  useEffect(() => {
    let cancelled = false
    classroomApi.me()
      .then(next => { if (!cancelled) setIdentity(next) })
      .catch(() => { if (!cancelled) setIdentity(null) })
    return () => { cancelled = true }
  }, [])

  // Which course's roster a teacher composites. Read once: changing student
  // rewrites the URL, and re-reading it here would fight that. No default —
  // absent means absent, because a fallback here shows a teacher the wrong
  // students' work with no error.
  const courseId = useMemo(() => new URLSearchParams(window.location.search).get('course') || '', [])

  useEffect(() => {
    if (identity?.role !== 'instructor' || !courseId) return
    let cancelled = false
    classroomApi.status(courseId)
      .then(status => { if (!cancelled) setClassroomRoster(status.rows) })
      .catch(() => { if (!cancelled) setClassroomRoster([]) })
    return () => { cancelled = true }
  }, [identity?.role, courseId])

  // Which layers this reader has. Derived from what rooms they actually have,
  // not from their role in the abstract. The set is derived; the two selections
  // over it are the reader's and are held — so the held selections are dropped
  // at the moment the base changes, during render rather than in an effect, so
  // no frame is drawn offering choices from the previous reader's layers.
  const baseLayers = useMemo(() => {
    if (identity?.role === 'student') return studentLayers()
    if (identity?.role === 'instructor') return teacherLayers(classroomRoster)
    return readerLayers()
  }, [identity?.role, classroomRoster])

  const [layersBase, setLayersBase] = useState(baseLayers)
  if (layersBase !== baseLayers) {
    setLayersBase(baseLayers)
    setLayers(baseLayers)
  }

  const mineLayer = layers.layers.find(l => l.id === 'mine')
  const commonVisible = layers.layers.find(l => l.id === 'common')?.visible ?? true

  // Which canvas holds which layer. Named rather than derived by complement:
  // "the other editor" is only right while there are exactly two layers, and a
  // teacher's view already has three.
  const editorForLayer = useCallback((id: BookLayerId) => (
    id === 'common' ? documentEditor : overlayEditors.get(id) ?? null
  ), [documentEditor, overlayEditors])

  const rememberOverlayEditor = useCallback((id: BookLayerId, editor: Editor | null) => {
    setOverlayEditors(current => {
      const next = new Map(current)
      if (editor) next.set(id, editor)
      else next.delete(id)
      return next
    })
  }, [])

  // Only the write target takes pointer input, so it is the only layer a
  // selection can be on — which makes "move the selection" unambiguous about
  // where it is moving FROM, with no rule needed to say so.
  const targetEditor = editorForLayer(layers.target)

  useEffect(() => {
    if (!targetEditor) return
    return react('selection on the write target', () => {
      setTrackedSelectionCount(targetEditor.getSelectedShapeIds().length)
      setMoveError('')
    })
  }, [targetEditor])

  const selectionCount = targetEditor ? trackedSelectionCount : 0

  /**
   * The conversion from the write target's frame into `destination`'s.
   *
   * Both layers are declared here rather than looked up, so the conversion is
   * asked of the model in every case — including the one where the answer is
   * the identity, which is what it is for classroom layers today. Special-casing
   * that would put the assumption back.
   */
  const frameConversionTo = useCallback((destination: BookLayerId) => {
    if (!documentEditor) return null
    const wm = getEditorWMCore(documentEditor)
    return layerFrameConversion(
      wm,
      ensureClassroomLayer(wm, layers.target),
      ensureClassroomLayer(wm, destination),
    )
  }, [documentEditor, layers.target])

  const moveSelectionToLayer = useCallback((destination: BookLayerId) => {
    const destinationEditor = editorForLayer(destination)
    const toDestinationFrame = frameConversionTo(destination)
    if (!targetEditor || !destinationEditor || !toDestinationFrame || destination === layers.target) return
    const ids = targetEditor.getSelectedShapeIds()
    try {
      moveShapesToLayer(layerStore(targetEditor), layerStore(destinationEditor), ids, toDestinationFrame)
      setMoveError('')
      // The destination is now where the work is, so that is where he is writing.
      setLayers(current => setWriteTarget(current, destination))
    } catch (error) {
      // The move refused rather than half-completing: the annotations are still
      // on the layer they were on. Say so, because "nothing happened" and
      // "something was lost" look identical from here.
      setMoveError((error as Error).message)
    }
  }, [targetEditor, editorForLayer, frameConversionTo, layers.target])

  // Copy does not move the write target: the originals are still on it, so that
  // is still where he is working. A move follows the work to its destination.
  const copySelectionToLayer = useCallback((destination: BookLayerId) => {
    const destinationEditor = editorForLayer(destination)
    const toDestinationFrame = frameConversionTo(destination)
    if (!targetEditor || !destinationEditor || !toDestinationFrame || destination === layers.target) return
    const ids = targetEditor.getSelectedShapeIds()
    try {
      copyShapesToLayer(layerStore(targetEditor), layerStore(destinationEditor), ids, createShapeId, toDestinationFrame)
      setMoveError('')
    } catch (error) {
      setMoveError((error as Error).message)
    }
  }, [targetEditor, editorForLayer, frameConversionTo, layers.target])

  const layersValue = useMemo<LayersValue>(() => ({
    state: layers,
    setVisible: (id, visible) => setLayers(current => setLayerVisible(current, id, visible)),
    setTarget: id => { setMoveError(''); setLayers(current => setWriteTarget(current, id)) },
    selectionCount,
    moveSelection: moveSelectionToLayer,
    copySelection: copySelectionToLayer,
    moveError,
  }), [layers, selectionCount, moveSelectionToLayer, copySelectionToLayer, moveError])

  // The overlay rooms. A student has their own; an instructor composites the
  // readable student layers over the document, with visibility from the one
  // layer menu rather than a serial tab to flick through. A reader with neither
  // credential gets no overlay and no control, and the document is unchanged.
  const overlays = (
    <>
      {identity?.role === 'student' && (
        <StudentAnnotationOverlay
          key={`${resetKey}:${identity.studentId}`}
          bookRoomId={roomId}
          studentId={identity.studentId}
          bookEditor={documentEditor}
          visible={mineLayer?.visible ?? false}
          isWriteTarget={layers.target === 'mine'}
          onEditorMount={editor => rememberOverlayEditor('mine', editor)}
        />
      )}
      {identity?.role === 'instructor' && courseId && classroomRoster.map(student => {
        const layerId = `student:${student.id}` as const
        const layer = layers.layers.find(candidate => candidate.id === layerId)
        return (
          <StudentAnnotationOverlay
            key={`${resetKey}:${student.id}`}
            bookRoomId={roomId}
            studentId={student.id}
            bookEditor={documentEditor}
            visible={layer?.visible ?? true}
            isWriteTarget={false}
            onEditorMount={editor => rememberOverlayEditor(layerId, editor)}
          />
        )
      })}
    </>
  )

  return {
    layersValue,
    /** The document's own annotations are the common layer, so hiding it hides them. */
    annotationsHidden: !commonVisible,
    overlays,
    identity,
  }
}
