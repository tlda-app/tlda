import { useEffect, useState } from 'react'
import { SvgDocumentEditor } from '../SvgDocument'
import { createHtmlDocumentFromPageInfo } from '../svgDocumentLoader'
import type { SvgDocument } from '../loaders/types'
import { classroomApi, type Assignment, type Submission } from './api'
import './ClassroomWorkspace.css'

// What a student sees of their own work.
//
// Skip, 26 June: "once you've submitted an assignment the solution becomes
// accessible to you and you can see it side-by-side yours." So this is the
// same compare surface he marks on, from the other side.
//
// The care here is about what must NOT appear. Feedback he has not returned is
// his working, not theirs — the server already withholds it, and the solution
// stays locked until they have submitted. This view asks for its data as the
// student and renders what comes back; it does not receive drafts and filter
// them, because a filter is a thing that can be got wrong once.

async function firstPage(docKey: string) {
  const basePath = `/docs/${encodeURIComponent(docKey)}/`
  const response = await fetch(`${basePath}page-info.json`)
  if (!response.ok) throw new Error('Your submission is still being prepared. Give it a moment and reload.')
  const pages = await response.json()
  if (!pages[0]) throw new Error('Your submission has no rendered page yet.')
  return { basePath, page: pages[0] }
}

export function StudentWork() {
  const params = new URLSearchParams(window.location.search)
  const assignmentId = params.get('assignment') || ''
  const [assignment, setAssignment] = useState<Assignment & { solutionsLocked?: boolean } | null>(null)
  const [submission, setSubmission] = useState<Submission | null>(null)
  const [document, setDocument] = useState<SvgDocument | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    classroomApi.assignment(assignmentId)
      .then(async next => {
        if (cancelled) return
        setAssignment(next)
        try {
          setSubmission(await classroomApi.mySubmission(assignmentId))
        } catch {
          // Not submitted yet is an ordinary state, not a failure.
          if (!cancelled) setSubmission(null)
        }
      })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [assignmentId])

  useEffect(() => {
    if (!submission?.contentRef) { setDocument(null); return }
    let cancelled = false
    const solutionsDocKey = assignment?.solutionsDocKey
    Promise.all([
      firstPage(submission.contentRef),
      solutionsDocKey ? firstPage(solutionsDocKey).catch(() => null) : Promise.resolve(null),
    ]).then(([mine, solution]) => {
      if (cancelled) return
      const pages = [{ ...mine.page, group: 'marked-exercise', url: mine.basePath + mine.page.file }]
      if (solution) pages.push({ ...solution.page, group: 'marked-exercise', url: solution.basePath + solution.page.file })
      setDocument(createHtmlDocumentFromPageInfo(submission.contentRef, mine.basePath, pages))
      setError('')
    }).catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [submission, assignment])

  if (error) return <main className="classroomWorkspace"><p className="classroomError">{error}</p></main>
  if (!loaded) return <main className="classroomWorkspace">Loading…</main>

  if (!submission) {
    return <main className="classroomWorkspace">
      <header><div><h1>{assignment?.title ?? assignmentId}</h1><div>Not submitted yet</div></div></header>
      <p>Upload your work to see it here. The solutions unlock once you have submitted.</p>
    </main>
  }

  // Only feedback that was actually returned reaches this list — the server
  // does not send drafts to a student, so there is nothing here to filter.
  const returned = submission.feedback

  return <>
    {document && <SvgDocumentEditor key={submission.contentRef} document={document} roomId={`doc-${submission.contentRef}`} />}
    <aside className="markingLifecycle" aria-label="Your submission">
      <span>Submitted {new Date(submission.submittedAt).toLocaleString()}</span>
      <span className="statusChip">{submission.gradingStatus}</span>
      {assignment?.solutionsLocked && <span>solutions unlock when you submit</span>}
      {returned.length > 0 && <span>{returned.length} comment{returned.length === 1 ? '' : 's'}</span>}
    </aside>
  </>
}
