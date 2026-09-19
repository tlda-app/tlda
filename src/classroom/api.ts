import { readClassroomToken } from './classroomToken'

export type GradingStatus = 'ungraded' | 'graded' | 'returned'
export interface Assignment {
  solutionsLocked?: boolean
 id: string; courseId: string; title: string; dueAt: string; solutionsDocKey?: string; solutionsVersion?: string; templateDocKey?: string; templateVersion?: string; sourceDocKey?: string; handoutDocKey?: string; bookPageFile?: string; submission?: Submission | null }
export interface StatusCell { assignmentId: string; state: 'not-submitted' | GradingStatus; studentId?: string; contentRef?: string; submittedAt?: string; gradingStatus?: GradingStatus; buildStatus?: string; buildAt?: string | null }
export type StudentLayerScope = 'student' | 'common'
export interface StatusRow { id: string; displayName: string; universityLogin?: string; layerScope: StudentLayerScope; assignments: StatusCell[] }
// One shape for both sides of the asymmetry: an instructor's `rows` are the
// whole class, a student's are their own single row. The server narrows it —
// the page does not filter, and there is nothing here it could filter with.
export interface CourseStatus { course: { id: string; title: string }; assignments: Assignment[]; rows: StatusRow[]; counts: Record<string, number>; viewer?: { role: 'instructor' | 'student' } }
export interface FeedbackMark { id: string; title: string; text: string; attached: boolean; visibility: 'instructor-draft' | 'returned' }
export interface ProblemAnswer { studentId: string; displayName: string; layerScope: StudentLayerScope; contentRef: string; gradingStatus: GradingStatus; anchor: string | null }
export interface ProblemsView { assignment: Assignment; problems: { problemId: string; answers: ProblemAnswer[] }[] }
// `returnedMarks` is how many marking shapes the return copied into the room the
// student may read. `null` when the return named no problem, so no marking layer
// was copied; absent on every response that is not a return.
export interface Submission { assignmentId: string; studentId: string; contentRef: string; submittedAt: string; gradingStatus: GradingStatus; feedback: FeedbackMark[]; answerIds?: string[]; returnedMarks?: number | null }
export interface RegisteredStudent { student: { id: string; courseId: string; displayName: string; preferredName?: string; pronouns?: string | null; layerScope: StudentLayerScope }; enrollmentToken: string }
export interface DeviceTransfer { transferUrl: string; qrSvg: string; expiresAt: string }
export interface RepairLink { student: { id: string; displayName: string }; repairUrl: string; qrSvg: string; expiresAt: string }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const classroomToken = readClassroomToken()
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

export type ClassroomIdentity =
  // `displayName` is the name the student registered under. Optional because a
  // principal resolver is free not to carry one, and a badge with no name says
  // nothing rather than saying "undefined".
  | { role: 'student'; studentId: string; courseId: string; displayName?: string; preferredName: string; pronouns?: string | null }
  // `preferredName` is null for a course that has none recorded. It is a display
  // string and nothing else in the instructor path reads it, so its absence must
  // not cost the caller their identity — the badge already shows no badge rather
  // than an empty name.
  | { role: 'instructor'; courseId: string; preferredName: string | null; pronouns?: string | null }

export const classroomApi = {
  // Who the caller is, from their token. The book surface needs this before it
  // can open the student's own annotation room, and there is no assignment in
  // hand there to ask through.
  me: () => {
    const course = new URLSearchParams(window.location.search).get('course')
    return request<ClassroomIdentity>(`/me${course ? `?course=${encodeURIComponent(course)}` : ''}`)
  },
  register: (courseId: string, body: { preferredName: string; pronouns?: string; universityLogin: string }) => request<RegisteredStudent>(`/courses/${encodeURIComponent(courseId)}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
  createDeviceTransfer: (courseId: string, returnPath: string) => request<DeviceTransfer>(`/courses/${encodeURIComponent(courseId)}/device-transfer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnPath }),
  }),
  redeemDeviceTransfer: (courseId: string, transferCode: string) => request<RegisteredStudent>(`/courses/${encodeURIComponent(courseId)}/device-transfer/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transferCode }),
  }),
  // A link the instructor sends to a student who cannot get back in on their own.
  // It resolves to that student's existing row, so it repairs rather than enrols.
  // `project` is where redeeming it lands them; the page supplies it because the
  // instructor's URL does not carry one and without it the app opens the picker.
  createRepairLink: (courseId: string, studentId: string, project?: string, assignmentId?: string) => request<RepairLink>(`/courses/${encodeURIComponent(courseId)}/students/${encodeURIComponent(studentId)}/repair-link`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, assignmentId }),
  }),
  status: (courseId: string) => request<CourseStatus>(`/courses/${encodeURIComponent(courseId)}/status`),
  // The course's assignments, which both a student and an instructor may read.
  // It is the only place that says which documents of a course are homework, so
  // it is what the table of contents asks to mark them. A reader with no
  // classroom credential gets 401 and no marks.
  assignments: (courseId: string) => request<{ assignments: Assignment[] }>(`/courses/${encodeURIComponent(courseId)}/assignments`),
  problems: (assignmentId: string) => request<ProblemsView>(`/assignments/${encodeURIComponent(assignmentId)}/problems`),
  // The student's own work. Their identity comes from their token, so this
  // takes no student id and cannot be aimed at anyone else.
  mySubmission: (assignmentId: string) => request<Submission>(`/assignments/${encodeURIComponent(assignmentId)}/mine`),
  uploadMine: (assignmentId: string, archive: File) => request<Submission>(`/assignments/${encodeURIComponent(assignmentId)}/mine/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: archive,
  }),
  uploadForStudent: (assignmentId: string, studentId: string, archive: File) => request<Submission>(`/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(studentId)}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: archive,
  }),
  assignment: (id: string) => request<Assignment>(`/assignments/${encodeURIComponent(id)}`),
  submission: (assignmentId: string, studentId: string) => request<Submission>(`/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(studentId)}`),
  feedback: (assignmentId: string, studentId: string, body: { title: string; text: string; attached?: boolean }) => request<{ id: string }>(`/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(studentId)}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  grade: (assignmentId: string, studentId: string) => request<Submission>(`/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(studentId)}/grade`, { method: 'POST' }),
  // TWO OPERATIONS, ONE ROUTE, AND THEY ARE NOT THE SAME REQUEST.
  //
  // This was a single call with an optional `problemId`, which made the marking
  // surface's bug expressible in one line: it omitted the problem, so the route
  // copied no marking layer, still marked the submission returned, still
  // answered 200, and the button reported a count of the local draft. The
  // student got nothing and the submission said returned.
  //
  // Splitting them is what stops that rather than a test would: returning a
  // marked problem has nowhere to put a missing problem id, and returning
  // feedback has nowhere to put one at all. Neither can be called as the other.

  /**
   * Return an instructor's marks on ONE problem, copying that marking layer into
   * the room the student may read. `returnedMarks` counts what was copied.
   */
  returnMarkedProblem: (assignmentId: string, studentId: string, problemId: string) => request<Submission>(`/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(studentId)}/return`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ problemId }),
  }),
  /**
   * Make the instructor's written feedback on a submission visible to its
   * student. It names no problem because it carries no marks, so `returnedMarks`
   * comes back null — that is this operation's correct answer, not a failure.
   */
  returnFeedback: (assignmentId: string, studentId: string) => request<Submission>(`/assignments/${encodeURIComponent(assignmentId)}/submissions/${encodeURIComponent(studentId)}/return`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  }),
}
