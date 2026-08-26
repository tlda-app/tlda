import { useState, useEffect, useCallback, useMemo } from 'react'
import type { Editor } from 'tldraw'
import { classroomApi, type StatusRow } from './api'
import { StudentAnnotationOverlay } from './StudentAnnotationOverlay'
import './ClassroomWorkspace.css'

// The teacher reading one student's layer over the book.
//
// Skip's model for looking at student work is flicking, not opening: "I could
// just, like, flip through the different students per problem... wouldn't have
// to, like, open a new page to grade different students." So changing student
// swaps which room the overlay is synced to and nothing else — no navigation,
// no reload, and the book underneath is never remounted.
//
// He reads here. His own marking marks are written where marking already puts
// them and are returned to a student deliberately; an instructor who landed in
// a student's layer drawing live would be a different feature, and not one he
// asked for. That is why the overlay is mounted read-only, with no path in this
// component that makes it otherwise.

interface TeacherStudentOverlayProps {
  /** The room the book itself is synced to. */
  bookRoomId: string
  /** Which course's roster to flick through. */
  courseId: string
  /** The book's editor, so the overlay follows its camera. */
  bookEditor: Editor | null
}

export function TeacherStudentOverlay({ bookRoomId, courseId, bookEditor }: TeacherStudentOverlayProps) {
  const [roster, setRoster] = useState<StatusRow[]>([])
  const [index, setIndex] = useState(0)
  const [error, setError] = useState('')

  // Whoever the URL named, so a reload lands on the same student.
  const requested = useMemo(() => new URLSearchParams(window.location.search).get('student') || '', [])

  useEffect(() => {
    let cancelled = false
    classroomApi.status(courseId)
      .then(next => {
        if (cancelled) return
        setRoster(next.rows)
        const at = next.rows.findIndex(row => row.id === requested)
        if (at >= 0) setIndex(at)
      })
      .catch(e => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [courseId, requested])

  const student = roster[index]

  // The URL follows what he is looking at, so a reload lands back here and the
  // link is shareable — but flicking never navigates. Same rule as the marking
  // view, which is where he asked for it.
  useEffect(() => {
    if (!student) return
    const next = new URLSearchParams(window.location.search)
    next.set('student', student.id)
    window.history.replaceState({}, '', `?${next}`)
  }, [student])

  const step = useCallback((delta: number) => {
    setIndex(current => {
      const count = roster.length
      if (!count) return current
      return ((current + delta) % count + count) % count
    })
  }, [roster.length])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') step(1)
      else if (event.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step])

  if (error) return <aside className="markingLifecycle" aria-label="Student layer"><span className="classroomError">{error}</span></aside>
  if (!student) return null

  return <>
    {/* Visible, never the write target: he is reading their layer, not drawing
        in it. Marks he returns to a student are written where marking already
        writes them. */}
    <StudentAnnotationOverlay
      key={`${bookRoomId}:${student.id}`}
      bookRoomId={bookRoomId}
      studentId={student.id}
      bookEditor={bookEditor}
      visible
      isWriteTarget={false}
    />
    {/* Same bar, same weight, as the marking view's student stepper. */}
    <aside className="markingLifecycle" aria-label="Student layer">
      <button onClick={() => step(-1)} aria-label="Previous student">←</button>
      <span>{student.displayName} · {index + 1} of {roster.length}</span>
      <button onClick={() => step(1)} aria-label="Next student">→</button>
    </aside>
  </>
}
