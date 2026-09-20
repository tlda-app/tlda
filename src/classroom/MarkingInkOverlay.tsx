import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useValue, type Editor } from 'tldraw'
import { gradingDraftRoomId, gradingReturnedRoomId } from '../../shared/classroom-rooms.mjs'
import { ReplyPlus } from './ReplyPlus'
import { ThreadPlayer } from './ThreadPlayer'
import type { PlayingLayer } from './replyLayer'
import { ensureViewLayer, getEditorWMCore, removeLayers } from '../wm/editor-wm'
import { classroomApi } from './api'
import { AnswerPane } from './AnswerPane'
import { StudentAnnotationOverlay } from './StudentAnnotationOverlay'
import { markingInkLayerId } from './markingInkFrame'
import { useInkFrame } from './useInkFrame'

export interface ActiveMarkingPair {
  exerciseId: string
  studentId: string
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
  return (
    <>
      {pairs.map(pair => (
        <MarkedPair
          key={`${pair.wrapper.ownerDocument.URL}:${pair.exerciseId}`}
          pair={pair}
          editor={editor}
          bookRoomId={bookRoomId}
          marked={pair === marked}
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
}: {
  pair: ActiveMarkingPair
  editor: Editor
  bookRoomId: string
  /** Whether this is the pair the glass and the Return button are on. */
  marked: boolean
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
  // Bumped when a layer finishes recording, so the player's list picks it up.
  // A thread you just added to that does not show what you added reads as the
  // recording having failed.
  const [threadRevision, setThreadRevision] = useState(0)
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
  const showsInk = marked || pair.viewerRole !== 'instructor'
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

  if (!frame) return null
  const returnMarks = async () => {
    if (returning || pair.viewerRole !== 'instructor') return
    try {
      setReturning(true)
      setReturnStatus(null)
      const { returnedMarks } = await classroomApi.returnMarkedProblem(pair.assignmentId, pair.studentId, problemId)
      // The server's count of what it copied, not the local draft's. This button
      // only exists while the draft holds shapes, so nothing copied means the
      // copy failed — and that has to read as a failure here rather than as a
      // green count, which is what it did while delivering nothing.
      setReturnStatus(returnedMarks
        ? { pairKey, text: `Returned ${returnedMarks}`, error: false }
        : { pairKey, text: 'Returned nothing — the student received no marks', error: true })
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
        isWriteTarget={pair.viewerRole === 'instructor'}
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
      {/* `showsInk` rather than `marked`, and the flag is answer-pane's: `marked`
          is one pair, and a student has all of theirs open, so gating on it put
          the plus on whichever exercise installed last and on none of the other
          twelve. They caught it in my code having just hit the same shape in
          their own. */}
      {showsInk && answerHeader && createPortal(
        <>
          <ThreadPlayer
            answer={answerRef}
            doc={pair.contentRef}
            onPlayingChange={setPlaying}
            revision={threadRevision}
          />
          <ReplyPlus
            answer={answerRef}
            doc={pair.contentRef}
            editor={draftEditor}
            playing={playing}
            onLayerRecorded={() => setThreadRevision(n => n + 1)}
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
