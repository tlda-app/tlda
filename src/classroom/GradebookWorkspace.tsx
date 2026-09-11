import { useEffect, useRef, useState } from 'react'
import { classroomApi, type CourseStatus, type RepairLink } from './api'
import { cellLabel, countLabel } from './markingLabels'
import './ClassroomWorkspace.css'

/**
 * The repair link for one student, on the roster row that names them.
 *
 * A student who cannot get back in cannot ask for this — the request that issues
 * one needs the enrolment token they have lost. So it is minted here, where the
 * instructor is already looking at the person it is for, and it comes back as
 * text to put in an email rather than as a page to navigate to.
 *
 * Minted per click rather than shown for every row at once: each one is a live
 * single-use credential, and a table that hands out thirty of them on load has
 * issued twenty-nine nobody asked for.
 */
function RepairLinkCell({ courseId, studentId, project }: { courseId: string; studentId: string; project?: string }) {
  const [link, setLink] = useState<RepairLink | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  // `navigator.clipboard` does not exist on an insecure origin, and this server
  // serves plain HTTP on a direct tailnet address. Selecting the text first means
  // the button leaves the link ready for ⌘C wherever the write is unavailable,
  // instead of throwing out of an onClick and doing nothing visible.
  const copy = () => {
    field.current?.select()
    navigator.clipboard?.writeText(link!.repairUrl).catch(() => {})
  }

  const mint = async () => {
    if (busy) return
    try {
      setBusy(true)
      setError('')
      setLink(await classroomApi.createRepairLink(courseId, studentId, project))
    } catch (nextError) {
      setError((nextError as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (link) return <td className="classroomRepairLink">
    <input ref={field} readOnly value={link.repairUrl} onFocus={event => event.currentTarget.select()} aria-label={`Repair link for ${studentId}`} />
    <button type="button" onClick={copy}>Copy</button>
    <small>Single use; expires {new Date(link.expiresAt).toLocaleDateString()}</small>
  </td>

  return <td className="classroomRepairLink">
    <button type="button" onClick={mint} disabled={busy}>{busy ? 'Making…' : 'Repair link'}</button>
    {error && <small className="classroomError">{error}</small>}
  </td>
}

// One page, one asymmetry. The instructor sees the whole class; a student sees
// their own row. The narrowing happens on the server — this renders whatever
// `rows` comes back holding, and has no filter of its own, so the two views
// cannot disagree about a submission's state.

export function GradebookWorkspace() {
  const params = new URLSearchParams(window.location.search)
  const courseId = params.get('course') || 'qtm285'
  const [data, setData] = useState<CourseStatus | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { classroomApi.status(courseId).then(setData).catch(e => setError(e.message)) }, [courseId])
  if (error) return <main className="classroomWorkspace"><p className="classroomError">{error}</p></main>
  if (!data) return <main className="classroomWorkspace">Loading submissions…</main>

  const isStudent = data.viewer?.role === 'student'

  // An instructor opens a submission to mark it. A student opens their own work,
  // which is a different surface and the only one they may reach.
  const open = (assignmentId: string, studentId: string, contentRef: string) => {
    const next = new URLSearchParams(window.location.search)
    next.delete('course')
    if (isStudent) {
      next.set('workspace', 'classroom-work')
      next.set('assignment', assignmentId)
      return `?${next}`
    }
    next.delete('workspace')
    next.set('project', contentRef)
    next.set('markingCourse', courseId)
    next.set('markingAssignment', assignmentId)
    next.set('markingStudent', studentId)
    const assignment = data.assignments.find(item => item.id === assignmentId)
    if (assignment?.solutionsDocKey) next.set('compareDoc', assignment.solutionsDocKey)
    return `?${next}`
  }

  const counts = <div className="classroomCounts">
    {Object.entries(data.counts).filter(([, total]) => total > 0)
      .map(([key, total]) => <span key={key}>{total} {countLabel(key)}</span>)}
  </div>

  // What a student came here to find out: for every assignment, is my work
  // present, and has it been marked. Assignments they have not handed in are
  // rows too — an absence is the thing they most need to see.
  if (isStudent) {
    const mine = data.rows[0]
    const cells = new Map((mine?.assignments || []).map(cell => [cell.assignmentId, cell]))
    return <main className="classroomWorkspace">
      <header><div><h1>{data.course.title}</h1><div>Your submissions</div></div>{counts}</header>
      <table className="classroomTable classroomSubmissionTable">
        <thead><tr><th>Assignment</th><th>Due</th><th>Handed in</th><th>Status</th><th>Work</th></tr></thead>
        <tbody>{data.assignments.map(assignment => {
          const cell = cells.get(assignment.id)
          return <tr key={assignment.id} className={`state-${cell?.state || 'not-submitted'}`}>
            <td>{assignment.title}</td>
            <td><small>{new Date(assignment.dueAt).toLocaleString()}</small></td>
            <td>{cell?.submittedAt ? new Date(cell.submittedAt).toLocaleString() : '—'}</td>
            <td><span className="statusChip">{cellLabel(cell?.state || 'not-submitted')}</span></td>
            <td>{cell?.contentRef
              ? <a href={open(assignment.id, mine.id, cell.contentRef)}>Open your work</a>
              : <a href={`?workspace=classroom-work&assignment=${encodeURIComponent(assignment.id)}`}>Hand it in</a>}</td>
          </tr>
        })}</tbody>
      </table>
    </main>
  }

  // Where a repair link should land its student: the same project the class link
  // sends everyone to. `tlda classroom setup` prints the registration link as
  // `project=<sourceDocKey>`, and that key is the only record of it the page can
  // reach — a course row does not name a project. Absent one, a repair link
  // simply carries no project and behaves as it did before.
  const classProject = data.assignments.find(assignment => assignment.sourceDocKey)?.sourceDocKey
  const assignments = new Map(data.assignments.map(assignment => [assignment.id, assignment]))
  const submissions = data.rows.flatMap(student => student.assignments
    .filter(cell => cell.contentRef)
    .map(cell => ({ student, cell, assignment: assignments.get(cell.assignmentId) })))
  return <main className="classroomWorkspace">
    <header><div><h1>{data.course.title}</h1><div>Submissions and marking</div></div>{counts}</header>
    <h2>Submitted homework</h2>
    <nav className="classroomComparisonLinks" aria-label="Homework comparisons">
      {data.assignments.map(assignment => <a key={assignment.id} href={`?workspace=classroom-comparison&course=${encodeURIComponent(courseId)}&assignment=${encodeURIComponent(assignment.id)}`}>
        Compare {assignment.title}
      </a>)}
    </nav>
    <table className="classroomTable classroomSubmissionTable">
      <thead><tr><th>Assignment</th><th>Student</th><th>Accepted</th><th>Status</th><th>Build</th><th>Work</th></tr></thead>
      <tbody>{submissions.map(({ student, cell, assignment }) => <tr key={`${cell.assignmentId}:${student.id}`}>
        <td>{assignment?.title || cell.assignmentId}</td>
        <td>{student.displayName}{student.universityLogin && <><br/><small>{student.universityLogin}</small></>}</td>
        <td>{cell.submittedAt ? new Date(cell.submittedAt).toLocaleString() : 'Recorded'}</td>
        <td><span className="statusChip">{cellLabel(cell.state)}</span></td>
        <td><span className={`classroomBuildStatus build-${cell.buildStatus || 'unknown'}`}>{cell.buildStatus || 'unknown'}</span>{cell.buildAt && <><br/><small>{new Date(cell.buildAt).toLocaleString()}</small></>}</td>
        <td><a href={open(cell.assignmentId, student.id, cell.contentRef!)}>Open submitted work</a></td>
      </tr>)}</tbody>
    </table>
    <h2>Roster</h2>
    <table className="classroomTable"><thead><tr><th>Student</th>{data.assignments.map(a => <th key={a.id}>{a.title}<br/><small>Due {new Date(a.dueAt).toLocaleString()}</small></th>)}<th>Access<br/><small>Send when they cannot get in</small></th></tr></thead>
      <tbody>{data.rows.map(row => <tr key={row.id}><th>{row.displayName}{row.universityLogin && <><br/><small>{row.universityLogin}</small></>}</th>{row.assignments.map(cell => <td key={cell.assignmentId} className={`state-${cell.state}`}>{cell.state === 'not-submitted' || !cell.contentRef ? cellLabel('not-submitted') : <a href={open(cell.assignmentId,row.id,cell.contentRef)}>{cellLabel(cell.state)}<br/><small>{cell.submittedAt && new Date(cell.submittedAt).toLocaleString()}</small></a>}</td>)}<RepairLinkCell courseId={courseId} studentId={row.id} project={classProject} /></tr>)}</tbody>
    </table>
  </main>
}
