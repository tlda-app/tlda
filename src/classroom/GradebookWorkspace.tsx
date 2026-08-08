import { useEffect, useState } from 'react'
import { classroomApi, type CourseStatus } from './api'
import './ClassroomWorkspace.css'

export function GradebookWorkspace() {
  const params = new URLSearchParams(window.location.search)
  const courseId = params.get('course') || 'qtm285'
  const [data, setData] = useState<CourseStatus | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { classroomApi.status(courseId).then(setData).catch(e => setError(e.message)) }, [courseId])
  if (error) return <main className="classroomWorkspace"><p className="classroomError">{error}</p></main>
  if (!data) return <main className="classroomWorkspace">Loading submissions…</main>
  const open = (assignmentId: string, studentId: string, contentRef: string) => {
    const next = new URLSearchParams(window.location.search)
    next.delete('workspace')
    next.delete('course')
    next.set('doc', contentRef)
    next.set('markingCourse', courseId)
    next.set('markingAssignment', assignmentId)
    next.set('markingStudent', studentId)
    const assignment = data.assignments.find(item => item.id === assignmentId)
    if (assignment?.solutionsDocKey) next.set('compareDoc', assignment.solutionsDocKey)
    return `?${next}`
  }
  return <main className="classroomWorkspace">
    <header><div><h1>{data.course.title}</h1><div>Submissions and grading</div></div><div className="classroomCounts"><span>{data.counts.missing} missing</span><span>{data.counts.ungraded} ungraded</span><span>{data.counts.returned} returned</span></div></header>
    <table className="classroomTable"><thead><tr><th>Student</th>{data.assignments.map(a => <th key={a.id}>{a.title}<br/><small>Due {new Date(a.dueAt).toLocaleString()}</small></th>)}</tr></thead>
      <tbody>{data.rows.map(row => <tr key={row.id}><th>{row.displayName}</th>{row.assignments.map(cell => <td key={cell.assignmentId} className={`state-${cell.state}`}>{cell.state === 'not-submitted' || !cell.contentRef ? 'Not submitted' : <a href={open(cell.assignmentId,row.id,cell.contentRef)}>{cell.state}<br/><small>{cell.submittedAt && new Date(cell.submittedAt).toLocaleString()}</small></a>}</td>)}</tr>)}</tbody>
    </table>
  </main>
}
