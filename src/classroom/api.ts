export type GradingStatus = 'ungraded' | 'graded' | 'returned'
export interface Assignment { id: string; courseId: string; title: string; dueAt: string; solutionsDocKey?: string; solutionsVersion?: string; templateDocKey?: string; templateVersion?: string }
export interface StatusCell { assignmentId: string; state: 'not-submitted' | GradingStatus; studentId?: string; contentRef?: string; submittedAt?: string; gradingStatus?: GradingStatus }
export interface StatusRow { id: string; displayName: string; assignments: StatusCell[] }
export interface CourseStatus { course: { id: string; title: string }; assignments: Assignment[]; rows: StatusRow[]; counts: Record<string, number> }
export interface FeedbackMark { id: string; title: string; text: string; attached: boolean; visibility: 'instructor-draft' | 'returned' }
export interface Submission { assignmentId: string; studentId: string; contentRef: string; submittedAt: string; gradingStatus: GradingStatus; feedback: FeedbackMark[] }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/classroom${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`)
  return response.json()
}

export const classroomApi = {
  status: (courseId: string) => request<CourseStatus>(`/courses/${encodeURIComponent(courseId)}/status`),
  assignment: (id: string) => request<Assignment>(`/assignments/${encodeURIComponent(id)}`),
  submission: (assignmentId: string, studentId: string) => request<Submission>(`/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(studentId)}`),
  feedback: (assignmentId: string, studentId: string, body: { title: string; text: string; attached?: boolean }) => request<{ id: string }>(`/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(studentId)}/feedback`, { method: 'POST', body: JSON.stringify(body) }),
  grade: (assignmentId: string, studentId: string) => request<Submission>(`/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(studentId)}/grade`, { method: 'POST' }),
  returnFeedback: (assignmentId: string, studentId: string) => request<Submission>(`/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(studentId)}/return`, { method: 'POST' }),
}
