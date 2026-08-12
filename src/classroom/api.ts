export type GradingStatus = 'ungraded' | 'graded' | 'returned'
export interface Assignment {
  solutionsLocked?: boolean
 id: string; courseId: string; title: string; dueAt: string; solutionsDocKey?: string; solutionsVersion?: string; templateDocKey?: string; templateVersion?: string }
export interface StatusCell { assignmentId: string; state: 'not-submitted' | GradingStatus; studentId?: string; contentRef?: string; submittedAt?: string; gradingStatus?: GradingStatus }
export interface StatusRow { id: string; displayName: string; assignments: StatusCell[] }
export interface CourseStatus { course: { id: string; title: string }; assignments: Assignment[]; rows: StatusRow[]; counts: Record<string, number> }
export interface FeedbackMark { id: string; title: string; text: string; attached: boolean; visibility: 'instructor-draft' | 'returned' }
export interface ProblemAnswer { studentId: string; displayName: string; contentRef: string; gradingStatus: GradingStatus; anchor: string | null }
export interface ProblemsView { assignment: Assignment; problems: { problemId: string; answers: ProblemAnswer[] }[] }
export interface Submission { assignmentId: string; studentId: string; contentRef: string; submittedAt: string; gradingStatus: GradingStatus; feedback: FeedbackMark[] }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const classroomToken = new URLSearchParams(window.location.search).get('classroomToken')
  const response = await fetch(`/api/classroom${path}`, {
    ...init,
    headers: {
      ...(classroomToken ? { 'x-tlda-student-token': classroomToken } : {}),
      ...(init?.headers || {}),
    },
  })
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`)
  return response.json()
}

export const classroomApi = {
  status: (courseId: string) => request<CourseStatus>(`/courses/${encodeURIComponent(courseId)}/status`),
  problems: (assignmentId: string) => request<ProblemsView>(`/assignments/${encodeURIComponent(assignmentId)}/problems`),
  // The student's own work. Their identity comes from their token, so this
  // takes no student id and cannot be aimed at anyone else.
  mySubmission: (assignmentId: string) => request<Submission>(`/assignments/${encodeURIComponent(assignmentId)}/mine`),
  uploadMine: (assignmentId: string, archive: File) => request<Submission>(`/assignments/${encodeURIComponent(assignmentId)}/mine/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: archive,
  }),
  assignment: (id: string) => request<Assignment>(`/assignments/${encodeURIComponent(id)}`),
  submission: (assignmentId: string, studentId: string) => request<Submission>(`/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(studentId)}`),
  feedback: (assignmentId: string, studentId: string, body: { title: string; text: string; attached?: boolean }) => request<{ id: string }>(`/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(studentId)}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  grade: (assignmentId: string, studentId: string) => request<Submission>(`/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(studentId)}/grade`, { method: 'POST' }),
  returnFeedback: (assignmentId: string, studentId: string) => request<Submission>(`/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(studentId)}/return`, { method: 'POST' }),
}
