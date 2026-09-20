import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useValue, type Editor } from 'tldraw'
import { gradingDraftRoomId, gradingReturnedRoomId } from '../../shared/classroom-rooms.mjs'
import { ReplyPlus } from './ReplyPlus'
import { ThreadPlayer } from './ThreadPlayer'
import type { PlayingLayer } from './replyLayer'
import { useLayers } from './layersContext'
import { listRecordingDraftsIncludingLayers } from '../recording/recordingApi'
import type { ThreadLayerSummary } from '../recording/annotationThread'
import { ensureViewLayer, getEditorWMCore, removeLayers } from '../wm/editor-wm'
import { classroomApi } from './api'
import { AnswerPane } from './AnswerPane'
import { StudentAnnotationOverlay } from './StudentAnnotationOverlay'
import { markingInkLayerId } from './markingInkFrame'
import { useInkFrame } from './useInkFrame'

export interface ActiveMarkingPair {
  exerciseId: string
  studentId: string
  /** Whose work, as the pager already says it. A picker row naming a person
   *  by their login is a debug list; this is the name he uses for them. */
  displayName: string
  contentRef: string
  assignmentId: string
  viewerRole: 'instructor' | 'student'
  wrapper: HTMLElement
  /** The answer, marked up for the pane to render as a document of its own. */
  answerMarkup: string
}

/**
 * Every open pair's answer, and the glass on the one he is marking.
 *
 * READING AND MARKING ARE SEPARATE HERE, deliberately. His gradebook link opens
 * one student on every solution in the chapter, so he expects to read that
 * person's work all the way down the margin; but a mark belongs to one answer,
 * and a glass is a tldraw editor, so seven of them is not the same proposition
 * as seven iframes. Each pair gets a pane; the last one he paged gets the glass
 * and the Return button.
 */
export function MarkingInkOverlay({
  pairs,
  editor,
  bookRoomId,
}: {
  pairs: ActiveMarkingPair[]
  editor: Editor
  bookRoomId: string
}) {
  // The most recent arrival is the one he is on. `onShow` appends, so this is
  // "the pair he last paged to" without anything having to track intent.
  const marked = pairs[pairs.length - 1]

  // One listing per project, not one per pane. A student arrives with every
  // answer they have open -- thirteen, measured -- and each pane's layers come
  // out of the same project's recordings, so asking per pane would be thirteen
  // identical requests for one answer.
  const docs = useMemo(
    () => [...new Set(pairs.map(pair => pair.contentRef))].sort().join('\u0000'),
    [pairs],
  )
  const [layersByDoc, setLayersByDoc] = useState<Record<string, ThreadLayerSummary[]>>({})
  const [revision, setRevision] = useState(0)
  const noteLayerRecorded = useCallback(() => setRevision(n => n + 1), [])

  useEffect(() => {
    if (!docs) return
    let cancelled = false
    void Promise.all(docs.split('\u0000').map(async doc => {
      const layers = await listRecordingDraftsIncludingLayers(doc) as ThreadLayerSummary[]
      return [doc, layers] as const
    })).then(entries => {
      if (!cancelled) setLayersByDoc(Object.fromEntries(entries))
    }).catch(() => {
      // A listing that fails leaves the players absent rather than the panes
      // broken; the marks themselves are a different path and still render.
    })
    return () => { cancelled = true }
  }, [docs, revision])

  return (
    <>
      {pairs.map(pair => (
        <MarkedPair
          key={`${pair.wrapper.ownerDocument.URL}:${pair.exerciseId}`}
          pair={pair}
          editor={editor}
          bookRoomId={bookRoomId}
          marked={pair === marked}
          layers={layersByDoc[pair.contentRef] ?? []}
          onLayerRecorded={noteLayerRecorded}
        />
      ))}
    </>
  )
}

function MarkedPair({
  pair,
  editor,
  bookRoomId,
  marked,
  layers,
  onLayerRecorded,
}: {
  pair: ActiveMarkingPair
  editor: Editor
  bookRoomId: string
  /** Whether this is the pair the glass and the Return button are on. */
  marked: boolean
  /** This project's layers, listed once by the overlay above. */
  layers: ThreadLayerSummary[]
  onLayerRecorded: () => void
}) {
  // The pane measures the answer and the frame places it, so the height goes
  // up from one and back down to the other. It starts at zero rather than at a
  // guess: an answer whose height we have not measured is not an answer of some
  // default height, and a wrong guess would put the glass over the wrong box
  // for a frame.
  const [answerHeight, setAnswerHeight] = useState(0)
  const [answerHeader, setAnswerHeader] = useState<HTMLElement | null>(null)
  const frame = useInkFrame(pair.wrapper, answerHeight, editor)
  const layerId = useMemo(
    () => markingInkLayerId(pair.contentRef, pair.exerciseId),
    [pair.contentRef, pair.exerciseId],
  )
  const [draftEditor, setDraftEditor] = useState<Editor | null>(null)
  const [returning, setReturning] = useState(false)
  // The layer open in front of the reader, if the player is running one. The
  // plus answers whatever this is, so it is the whole of "reply to anything".
  const [playing, setPlaying] = useState<PlayingLayer | null>(null)
  const layersValue = useLayers()
  // The two operations, not the whole context value. `layersValue` is rebuilt
  // on every state change in the hook; `register` and `unregister` are
  // `useCallback(..., [])` and so are stable. Depending on them is what lets
  // this effect declare its real dependencies instead of suppressing the rule.
  const register = layersValue?.register
  const unregister = layersValue?.unregister
  const courseId = useMemo(
    () => new URLSearchParams(window.location.search).get('course') || '',
    [],
  )
  const markingLayerId = `marking:${pair.contentRef}:${pair.exerciseId}` as const
  const isWriteTarget = layersValue?.state.target === markingLayerId
  // Which problem's marks these are. Named ONCE, because it is both the stem of
  // the draft room this overlay writes into and the problem `/return` copies
  // across, and those two being written out separately is what broke returning:
  // Return passed no problem at all, so the route's copy was skipped, the
  // submission was still marked returned, and the button still reported a count
  // — of the local draft it was reading, never of anything the student received.
  const problemId = `ans-${pair.exerciseId}`
  const answerRef = useMemo(
    () => ({ submissionRoomId: `doc-${pair.contentRef}`, problemId }),
    [pair.contentRef, problemId],
  )
  // THE TWO READERS ARE NOT IN THE SAME ROOM, and this is the whole of handback
  // on this surface.
  //
  // The instructor writes the draft; the student reads the copy a return makes.
  // `classroomRoomAccess` denies a student the draft unconditionally — even
  // after a return, so that marking resumed afterwards is not live to them —
  // so pointing both at the draft gave the student a glass over a room they
  // are refused, and their marks appeared nowhere on the chapter at all.
  //
  // Their marks were only ever visible on `StudentWork`, which lays their
  // submission out as its own document. There is no pair wrapper there, so the
  // coordinates — correct, and relative to the wrapper — put the mark off in
  // empty canvas. That is the detached mark, and it is a surface fault rather
  // than a coordinate one: `docs/classroom.md` says handback returns the marked
  // exercise "to the student in the book", and the book is this chapter, where
  // the wrapper exists for them exactly as it does for him.
  const marksRoomId = pair.viewerRole === 'instructor'
    ? gradingDraftRoomId(`doc-${pair.contentRef}`, problemId)
    : gradingReturnedRoomId(`doc-${pair.contentRef}`, problemId)
  // WHO NEEDS INK ON THIS PAIR.
  //
  // He marks one answer at a time, so one glass follows him and thirteen tldraw
  // editors would be a real cost for nothing. A STUDENT IS NOT MARKING. They
  // are reading work that was handed back, and every answer of theirs that
  // carries marks has to show them — with one glass, twelve of their thirteen
  // answers rendered nothing and the only stroke on screen was a stray already
  // in the chapter's own room, which is indistinguishable from it working.
  //
  // Theirs are read-only by construction: `isWriteTarget` below is the
  // instructor test, so this mounts a surface they can see and cannot write.
  // THE WRITE TARGET DECIDES WHERE INK GOES; `marked` DOES NOT DECIDE WHAT
  // RENDERS.
  //
  // `marked` is `pairs[pairs.length - 1]` -- the pair last paged to -- and it
  // was doing both jobs. With two problems open, switching rows in the picker
  // would move the highlight while ink kept landing in whichever pair was
  // paged to last: a picker that looks right and writes to the wrong layer.
  //
  // So the glass mounts on the pair the picker is pointing at. `marked` stays
  // in the condition because paging registers and takes the target, and the
  // first render after paging happens before that state lands -- without it the
  // glass would blink out between paging and registering.
  //
  // A student has no write target at all; their glasses are read-only, which is
  // why their side is unchanged.
  // WHERE A PICKER EXISTS IT DECIDES; WHERE IT DOES NOT, behave as before.
  //
  // `marked || isWriteTarget` kept the previously-marked pair's glass mounted
  // after switching away, so two glasses were live at once -- measured on the
  // serving build, pair 1 at top 926 and pair 2 still at 4160. With line 306
  // below also fixed they would merely be one read-only and one writable, but
  // an editor mounted over an answer nobody is marking is still an editor.
  //
  // The fallback is for the surfaces with no `LayersContext` -- `ProblemMarking`
  // and `StudentWork`. There is no target to follow there, so they keep exactly
  // the glass they have today rather than losing marking entirely.
  const showsInk = pair.viewerRole === 'instructor'
    ? (isWriteTarget || (marked && !layersValue))
    : true
  const pairKey = `${pair.exerciseId}:${pair.studentId}`
  const [returnStatus, setReturnStatus] = useState<{ pairKey: string; text: string; error: boolean } | null>(null)
  const draftShapeCount = useValue(
    'marking draft shape count',
    () => draftEditor?.getCurrentPageShapes().length ?? 0,
    [draftEditor],
  )

  useEffect(() => {
    // The view layer belongs to the glass, so an unmarked pair does not make
    // one. Otherwise every open pair would register a marking layer and only
    // one of them would ever have ink in it.
    if (!frame || !showsInk) return
    const wm = getEditorWMCore(editor)
    ensureViewLayer(wm, layerId, {
      parent: wm.rootLayerId,
      transform: frame.wrapperTransform,
    })
    return () => removeLayers(wm, [layerId])
  }, [editor, frame, layerId, showsInk])

  // MARKING STOPS DRAWING TO THE FRAMEBUFFER AND ASKS FOR A WINDOW.
  //
  // This overlay used to declare its layer to the wm and stop there, which is
  // why marking layers had no name, were absent from the picker, and could not
  // be swapped or hidden with it -- not because anything blocked them, but
  // because they were never in the list. Skip: "each solution tou have opened
  // like this ccreates what i was hoping would be a normal wm layer / you swap
  // between them hide them etc using the normal layer picker".
  //
  // So it registers. The list is what has been registered, and the layer exists
  // because a person opened something -- Skip again: "you get one layer for ech
  // problem you are actively marking". Opening registers; closing the pair
  // unregisters; nothing is per-problem-that-exists.
  //
  // Owner is the STUDENT whose work this hangs off, not the instructor who drew
  // on it: a mark on someone's homework is part of that homework. Group is the
  // course's instructors, the same group as the submission. `draftState` is what
  // this reader is bound to -- he writes the draft, they read the returned copy
  // -- so the row never claims a privacy the room behind it does not have.
  useEffect(() => {
    if (!register || !unregister || !frame) return
    const id = `marking:${pair.contentRef}:${pair.exerciseId}` as const
    register({
      id,
      // Whose work and which problem. The exercise has no human title in the
      // rendered chapter -- the callouts are titled "Exercise" generically,
      // measured -- so the id is the only thing naming the problem, stripped
      // of its prefix. The person, at least, is named as he names them.
      label: `${pair.displayName} — ${pair.exerciseId.replace(/^exr-/, '')}`,
      visible: true,
      studentId: pair.studentId,
      // He writes into a marking layer; a student reading returned marks does
      // not, which is the same read-only their glass already has.
      targetable: pair.viewerRole === 'instructor',
      // Not a move destination: see the picker's own note.
      movable: false,
      owner: pair.studentId,
      group: `instructors:${courseId}`,
      offerable: true,
      draftState: pair.viewerRole === 'instructor' ? 'draft' : 'returned',
    })
    return () => unregister(id)
  }, [register, unregister, frame, pair.contentRef, pair.exerciseId, pair.studentId,
      pair.displayName, pair.viewerRole, courseId])

  if (!frame) return null
  // The return, with or without a take. Send's layer id travels here so the
  // mark and its track arrive together; the paused case passes none, and ink
  // with no recording still returns — that is ordinary marking.
  const returnMarks = async (layerId?: string | null) => {
    if (returning || pair.viewerRole !== 'instructor') return
    try {
      setReturning(true)
      setReturnStatus(null)
      const { returnedMarks, returnedLayerId } = await classroomApi.returnMarkedProblem(pair.assignmentId, pair.studentId, problemId, layerId ?? null)
      // The server's count of what it copied, not the local draft's. This button
      // only exists while the draft holds shapes, so nothing copied means the
      // copy failed — and that has to read as a failure here rather than as a
      // green count, which is what it did while delivering nothing.
      setReturnStatus(returnedMarks
        ? { pairKey, text: returnedLayerId ? `Returned ${returnedMarks} + voice` : `Returned ${returnedMarks}`, error: false }
        : { pairKey, text: 'Returned nothing — the student received no marks', error: true })
      if (returnedLayerId) onLayerRecorded()
    } catch (error) {
      setReturnStatus({ pairKey, text: (error as Error).message, error: true })
    } finally {
      setReturning(false)
    }
  }

  return (
    <>
      <AnswerPane
        markup={pair.answerMarkup}
        chapter={pair.wrapper.ownerDocument}
        bounds={frame.answerBounds}
        scale={frame.camera.z}
        onHeight={setAnswerHeight}
        onHeader={setAnswerHeader}
        marked={marked}
      />
      {showsInk && <StudentAnnotationOverlay
        bookRoomId={bookRoomId}
        studentId={pair.studentId}
        bookEditor={editor}
        visible
        // THE COMPUTED TARGET, not the role. This line was the defect: it is
        // true for an instructor on EVERY mounted pair, and it gates pointer
        // capture (`StudentAnnotationOverlay:157`), camera mirror-back (:221)
        // and tool following (:244) -- write authority, not appearance. So the
        // picker moved the glass while every glass still claimed the pen.
        isWriteTarget={isWriteTarget}
        roomId={marksRoomId}
        camera={frame.camera}
        bounds={frame.bounds}
        onEditorMount={setDraftEditor}
        onEditorRelease={released => setDraftEditor(current => current === released ? null : current)}
      />}
      {/* The plus is NOT gated on the instructor, and that is the point of it.
          Skip: "its a thread anyone can reply to anything" — so it sits in the
          student's header too, on their own returned answer.

          `playing` is null here because this surface has no player yet: a layer
          can be recorded on the answer but not yet played back beside it. So
          every layer the plus starts here is a root, which is a mark carrying
          ink and voice — the half of marking that was specified and never
          built. Answering an existing layer needs the player, and with it the
          warp, which is the next piece rather than something missing from
          this one. */}
      {/* `showsInk`, not `marked`, and the difference is the whole of "for both
          readers". `marked` is `pairs[pairs.length - 1]` -- exactly one pane.
          That was invisible while only one pair was ever open; a student now
          arrives with every answer they have open, so gating on it put the plus
          on whichever exercise installed last and on none of the other twelve.
          `answer-pane` caught this in my code having just hit it in their own,
          where 13 panes carried 1 glass. Their flag, their diagnosis. */}
      {showsInk && answerHeader && createPortal(
        <>
          <ThreadPlayer
            answer={answerRef}
            doc={pair.contentRef}
            layers={layers}
            onPlayingChange={setPlaying}
          />
          <ReplyPlus
            answer={answerRef}
            doc={pair.contentRef}
            editor={draftEditor}
            playing={playing}
            onLayerRecorded={onLayerRecorded}
            onSend={(layerId) => returnMarks(layerId)}
          />
        </>,
        answerHeader,
      )}
      {marked && pair.viewerRole === 'instructor' && answerHeader && createPortal(
        <span className="tlda-marking-return">
          {draftShapeCount > 0 && (
            <button type="button" disabled={returning} onClick={() => void returnMarks()}>
              {returning ? 'Returning…' : 'Return'}
            </button>
          )}
          {returnStatus?.pairKey === pairKey && (
            <span className={`tlda-marking-return-status${returnStatus.error ? ' tlda-marking-return-error' : ''}`}>
              {returnStatus.text}
            </span>
          )}
        </span>,
        answerHeader,
      )}
    </>
  )
}
