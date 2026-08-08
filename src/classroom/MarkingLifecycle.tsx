import { useEffect, useState } from 'react'
import { classroomApi, type Submission } from './api'
import './ClassroomWorkspace.css'

export function MarkingLifecycle() {
  const params = new URLSearchParams(window.location.search)
  const courseId = params.get('markingCourse')
  const assignmentId = params.get('markingAssignment')
  const studentId = params.get('markingStudent')
  const [submission, setSubmission] = useState<Submission | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!assignmentId || !studentId) return
    classroomApi.submission(assignmentId, studentId).then(setSubmission).catch(error => setError(error.message))
  }, [assignmentId, studentId])

  if (!courseId || !assignmentId || !studentId) return null
  const backParams = new URLSearchParams(window.location.search)
  for (const key of ['doc', 'compareDoc', 'markingCourse', 'markingAssignment', 'markingStudent']) backParams.delete(key)
  backParams.set('workspace', 'classroom-gradebook')
  backParams.set('course', courseId)
  const back = `?${backParams}`
  const returnMarkedExercise = async () => {
    try {
      setError('')
      setSubmission(await classroomApi.returnFeedback(assignmentId, studentId))
    } catch (error) {
      setError((error as Error).message)
    }
  }

  return <aside className="markingLifecycle" aria-label="Marked exercise lifecycle">
    <a href={back}>← Submissions</a>
    <span>{studentId}</span>
    {submission && <span className="statusChip">{submission.gradingStatus}</span>}
    {submission?.gradingStatus !== 'returned' && <button onClick={returnMarkedExercise} disabled={!submission}>Return marked exercise</button>}
    {error && <span className="classroomError">{error}</span>}
  </aside>
}
