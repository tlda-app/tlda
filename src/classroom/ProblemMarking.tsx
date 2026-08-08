import { useCallback, useEffect, useMemo, useState } from 'react'
import { SvgDocumentEditor } from '../SvgDocument'
import { createHtmlDocumentFromPageInfo } from '../svgDocumentLoader'
import type { SvgDocument } from '../loaders/types'
import { classroomApi, type ProblemsView } from './api'
import './ClassroomWorkspace.css'

// The assignment as Skip marks it: "that would just be the homework assignment
// and for each problem flick through the student solutions."
//
// So the problem is what stays put and the student is what moves. Flicking
// swaps the pane beside his solution rather than opening a page per student,
// which is the thing he asked not to have to do.

async function firstPage(docKey: string) {
  const basePath = `/docs/${encodeURIComponent(docKey)}/`
  const response = await fetch(`${basePath}page-info.json`)
  if (!response.ok) throw new Error(`${docKey} has not finished rendering`)
  const pages = await response.json()
  if (!pages[0]) throw new Error(`${docKey} has no rendered page`)
  return { basePath, page: pages[0] }
}

export function ProblemMarking() {
  const params = new URLSearchParams(window.location.search)
  const assignmentId = params.get('assignment') || ''
  const [view, setView] = useState<ProblemsView | null>(null)
  const [problemIndex, setProblemIndex] = useState(0)
  const [studentIndex, setStudentIndex] = useState(0)
  const [document, setDocument] = useState<SvgDocument | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    classroomApi.problems(assignmentId).then(setView).catch(e => setError(e.message))
  }, [assignmentId])

  const problem = view?.problems[problemIndex]
  const answer = problem?.answers[studentIndex]

  // Pair his solution with this student's answer. Same shape the compare view
  // already builds, so the two panes line up the way they do everywhere else.
  useEffect(() => {
    if (!view || !answer?.contentRef) { setDocument(null); return }
    let cancelled = false
    const solutionsDocKey = view.assignment.solutionsDocKey
    Promise.all([
      firstPage(answer.contentRef),
      solutionsDocKey ? firstPage(solutionsDocKey) : Promise.resolve(null),
    ]).then(([student, solution]) => {
      if (cancelled) return
      const pages = [{ ...student.page, group: 'marked-exercise', url: student.basePath + student.page.file }]
      if (solution) pages.push({ ...solution.page, group: 'marked-exercise', url: solution.basePath + solution.page.file })
      setDocument(createHtmlDocumentFromPageInfo(answer.contentRef, student.basePath, pages))
      setError('')
    }).catch(e => { if (!cancelled) { setError(e.message); setDocument(null) } })
    return () => { cancelled = true }
  }, [view, answer])

  // The URL follows what you're looking at, so a reload lands you back here and
  // the link is shareable — but flicking never navigates.
  useEffect(() => {
    if (!problem || !answer) return
    const next = new URLSearchParams(window.location.search)
    next.set('problem', problem.problemId)
    next.set('student', answer.studentId)
    window.history.replaceState({}, '', `?${next}`)
  }, [problem, answer])

  const step = useCallback((delta: number) => {
    if (!problem) return
    setStudentIndex(current => {
      const count = problem.answers.length
      return ((current + delta) % count + count) % count
    })
  }, [problem])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') step(1)
      else if (event.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step])

  const problemOptions = useMemo(() => view?.problems.map(p => p.problemId) ?? [], [view])

  if (error && !view) return <main className="classroomWorkspace"><p className="classroomError">{error}</p></main>
  if (!view) return <main className="classroomWorkspace">Loading {assignmentId}…</main>
  if (!problem) return <main className="classroomWorkspace"><p>No submissions yet for {view.assignment.title}.</p></main>

  return <>
    {document
      ? <SvgDocumentEditor key={`${problem.problemId}:${answer?.studentId}`} document={document} roomId={`doc-${answer?.contentRef}`} />
      : <main className="classroomWorkspace"><p className={error ? 'classroomError' : undefined}>{error || `${answer?.displayName} did not answer this one.`}</p></main>}
    <aside className="markingLifecycle" aria-label="Marking">
      <select value={problem.problemId} onChange={e => { setProblemIndex(problemOptions.indexOf(e.target.value)); setStudentIndex(0) }}>
        {problemOptions.map(id => <option key={id} value={id}>{id.replace(/^ans-/, '')}</option>)}
      </select>
      <button onClick={() => step(-1)} aria-label="Previous student">←</button>
      <span>{answer?.displayName} · {studentIndex + 1} of {problem.answers.length}</span>
      <button onClick={() => step(1)} aria-label="Next student">→</button>
      {answer && <span className="statusChip">{answer.gradingStatus}</span>}
    </aside>
  </>
}
