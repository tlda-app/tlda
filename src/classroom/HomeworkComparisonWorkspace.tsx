import { useEffect, useMemo, useState } from 'react'
import { classroomApi, type CourseStatus } from './api'
import './ClassroomWorkspace.css'

type ComparisonItem = {
  studentId: string
  displayName: string
  universityLogin?: string
  contentRef: string
}

function firstRenderedPage(docKey: string) {
  const basePath = `/docs/${encodeURIComponent(docKey)}/`
  return fetch(`${basePath}page-info.json`).then(async response => {
    if (!response.ok) throw new Error(`${docKey} is not ready (${response.status})`)
    const pages = await response.json()
    if (!pages[0]?.file) throw new Error(`${docKey} has no rendered page`)
    return `${basePath}${pages[0].file}`
  })
}

export function HomeworkComparisonWorkspace() {
  const params = new URLSearchParams(window.location.search)
  const courseId = params.get('course') || 'qtm285'
  const assignmentId = params.get('assignment') || ''
  const [data, setData] = useState<CourseStatus | null>(null)
  const [pages, setPages] = useState<Record<string, string>>({})
  const [pageErrors, setPageErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  useEffect(() => {
    classroomApi.status(courseId).then(setData).catch(e => setError(e.message))
  }, [courseId])

  const assignment = data?.assignments.find(item => item.id === assignmentId)
  const submissions = useMemo<ComparisonItem[]>(() => data?.rows.flatMap(student => {
    const cell = student.assignments.find(item => item.assignmentId === assignmentId)
    return cell?.contentRef ? [{
      studentId: student.id,
      displayName: student.displayName,
      universityLogin: student.universityLogin,
      contentRef: cell.contentRef,
    }] : []
  }) ?? [], [assignmentId, data])

  useEffect(() => {
    if (!assignment?.solutionsDocKey) return
    let cancelled = false
    const documents = [
      ['solution', assignment.solutionsDocKey] as const,
      ...submissions.map(item => [item.contentRef, item.contentRef] as const),
    ]
    Promise.all(documents.map(async ([key, docKey]) => {
      try { return { key, url: await firstRenderedPage(docKey) } }
      catch (e) { return { key, error: (e as Error).message } }
    })).then(results => {
      if (cancelled) return
      setPages(Object.fromEntries(results.filter(item => item.url).map(item => [item.key, item.url!])))
      setPageErrors(Object.fromEntries(results.filter(item => item.error).map(item => [item.key, item.error!])))
    })
    return () => { cancelled = true }
  }, [assignment?.solutionsDocKey, submissions])

  if (error) return <main className="classroomWorkspace"><p className="classroomError">{error}</p></main>
  if (!data) return <main className="classroomWorkspace">Loading homework comparison…</main>
  if (!assignment) return <main className="classroomWorkspace"><p className="classroomError">Assignment not found.</p></main>
  if (!assignment.solutionsDocKey) return <main className="classroomWorkspace"><p className="classroomError">The official solution is not configured.</p></main>

  return <main className="classroomWorkspace classroomComparisonWorkspace">
    <header>
      <div><h1>{assignment.title}</h1><div>Official solution and submitted homework</div></div>
      <a href={`?workspace=classroom-gradebook&course=${encodeURIComponent(courseId)}`}>Back to submissions</a>
    </header>
    <div className="classroomComparison" data-homework-comparison={assignment.id}>
      <section className="classroomComparisonSolution">
        <h2>Official solution</h2>
        {pages.solution && <iframe title={`${assignment.title} official solution`} src={pages.solution} />}
        {pageErrors.solution && <p className="classroomError">{pageErrors.solution}</p>}
      </section>
      <section className="classroomComparisonSubmissions" aria-label="Student submissions">
        {submissions.map(item => <article key={item.studentId} data-student-id={item.studentId}>
          <header>
            <h2>{item.displayName}</h2>
            <div>{item.universityLogin || item.studentId}</div>
            <a href={`?project=${encodeURIComponent(item.contentRef)}&compareDoc=${encodeURIComponent(assignment.solutionsDocKey!)}&markingCourse=${encodeURIComponent(courseId)}&markingAssignment=${encodeURIComponent(assignment.id)}&markingStudent=${encodeURIComponent(item.studentId)}`}>Open marking canvas</a>
          </header>
          {pages[item.contentRef] && <iframe title={`${item.displayName} submission`} src={pages[item.contentRef]} />}
          {pageErrors[item.contentRef] && <p className="classroomError">{pageErrors[item.contentRef]}</p>}
        </article>)}
        {submissions.length === 0 && <p>No submissions yet.</p>}
      </section>
    </div>
  </main>
}
