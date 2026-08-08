import type { HomeworkGradingLayerScope } from '../wm/homework-grading-surface'

export type FeedbackStatus = 'draft' | 'returned'
export type StoreId = 'instructor-grading-store' | 'student-accessible-store' | 'common-class-store'

export interface StudentRecord {
	id: string
	name: string
	summary: string
}

export interface FeedbackMark {
	id: string
	title: string
	text: string
	attached: boolean
	status: FeedbackStatus
	store: StoreId
	layerScope: HomeworkGradingLayerScope
	provenance: string
}

export interface TransferEvent {
	id: string
	studentId: string
	studentName: string
	markId: string
	markTitle: string
	from: StoreId
	to: StoreId
}

export interface HomeworkGradingState {
	activeStudentId: string
	marksByStudent: Record<string, FeedbackMark[]>
	transferLog: TransferEvent[]
}

export const HOMEWORK_GRADING_STORAGE_KEY = 'tlda-homework-grading-prototype-v1'

export const HOMEWORK_STUDENTS: StudentRecord[] = [
	{ id: 'student-a', name: 'Student A', summary: 'Sign error in different-prior subtraction.' },
	{ id: 'student-b', name: 'Student B', summary: 'Correct idea, sparse explanation.' },
	{ id: 'student-c', name: 'Student C', summary: 'Submitted, not opened yet.' },
]

export function initialMarks(studentId: string): FeedbackMark[] {
	if (studentId === 'student-b') {
		return [
			{
				id: 'mechanism-feedback-b',
				title: 'Make the mechanism explicit.',
				text: 'The calculation is right; add one sentence explaining why the opposite-direction biases compound.',
				attached: true,
				status: 'draft',
				store: 'instructor-grading-store',
				layerScope: 'grading-draft',
				provenance: 'instructor mark, not returned',
			},
			{
				id: 'cancellation-feedback-b',
				title: 'Add the cancellation sentence.',
				text: 'Say explicitly that same-direction bias mostly cancels in a difference, but opposite-direction bias compounds.',
				attached: false,
				status: 'draft',
				store: 'instructor-grading-store',
				layerScope: 'grading-draft',
				provenance: 'loose draft note',
			},
		]
	}
	if (studentId === 'student-c') {
		return [
			{
				id: 'placeholder-feedback-c',
				title: 'Open this submission.',
				text: 'No feedback has been attached yet.',
				attached: false,
				status: 'draft',
				store: 'instructor-grading-store',
				layerScope: 'grading-draft',
				provenance: 'unopened submission placeholder',
			},
		]
	}
	return [
		{
			id: 'sign-feedback',
			title: 'Check the sign here.',
			text: 'In mu(1) - mu(0), an upward bias on group 0 is subtracted. The two biases add; they do not cancel.',
			attached: true,
			status: 'draft',
			store: 'instructor-grading-store',
			layerScope: 'grading-draft',
			provenance: 'instructor mark, not returned',
		},
		{
			id: 'explanation-feedback',
			title: 'Add the cancellation sentence.',
			text: 'Say explicitly that same-direction bias mostly cancels in a difference, but opposite-direction bias compounds.',
			attached: false,
			status: 'draft',
			store: 'instructor-grading-store',
			layerScope: 'grading-draft',
			provenance: 'loose draft note',
		},
	]
}

export function createInitialHomeworkGradingState(activeStudentId = HOMEWORK_STUDENTS[0].id): HomeworkGradingState {
	return {
		activeStudentId,
		marksByStudent: Object.fromEntries(HOMEWORK_STUDENTS.map((student) => [student.id, initialMarks(student.id)])),
		transferLog: [],
	}
}

export function returnedCount(state: HomeworkGradingState, studentId: string): number {
	return (state.marksByStudent[studentId] ?? []).filter((mark) => mark.status === 'returned').length
}

export function currentStatus(state: HomeworkGradingState, studentId: string): FeedbackStatus {
	return returnedCount(state, studentId) > 0 ? 'returned' : 'draft'
}

export function toggleFeedbackAttachment(
	state: HomeworkGradingState,
	studentId: string,
	markId: string,
): HomeworkGradingState {
	return updateStudentMarks(state, studentId, (marks) => marks.map((mark) => (
		mark.id === markId && mark.status === 'draft' ? { ...mark, attached: !mark.attached } : mark
	)))
}

export function addFeedbackMark(
	state: HomeworkGradingState,
	studentId: string,
	{ title, text, attached = true }: { title: string; text: string; attached?: boolean },
): HomeworkGradingState {
	const cleanTitle = title.trim()
	const cleanText = text.trim()
	if (!cleanTitle || !cleanText) return state
	const mark: FeedbackMark = {
		id: `feedback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
		title: cleanTitle,
		text: cleanText,
		attached,
		status: 'draft',
		store: 'instructor-grading-store',
		layerScope: 'grading-draft',
		provenance: 'created in instructor grading store',
	}
	return updateStudentMarks(state, studentId, (marks) => [...marks, mark])
}

export function commitAttachedFeedback(
	state: HomeworkGradingState,
	student: StudentRecord,
	now = Date.now(),
): HomeworkGradingState {
	const marks = state.marksByStudent[student.id] ?? []
	const moving = marks.filter((mark) => mark.attached && mark.status === 'draft')
	if (moving.length === 0) return state
	const updatedMarks = marks.map((mark) => (
		mark.attached && mark.status === 'draft'
			? {
				...mark,
				status: 'returned' as const,
				store: 'student-accessible-store' as const,
				layerScope: 'returned-feedback' as const,
				provenance: 'moved from instructor grading store at commit',
			}
			: mark
	))
	const events = moving.map((mark, index) => ({
		id: `${now}-${index}-${mark.id}`,
		studentId: student.id,
		studentName: student.name,
		markId: mark.id,
		markTitle: mark.title,
		from: mark.store,
		to: 'student-accessible-store' as const,
	}))
	return {
		...state,
		marksByStudent: { ...state.marksByStudent, [student.id]: updatedMarks },
		transferLog: [...events, ...state.transferLog],
	}
}

export function resetStudentMarks(state: HomeworkGradingState, studentId: string): HomeworkGradingState {
	return {
		...state,
		marksByStudent: { ...state.marksByStudent, [studentId]: initialMarks(studentId) },
		transferLog: state.transferLog.filter((event) => event.studentId !== studentId),
	}
}

export function selectStudent(state: HomeworkGradingState, studentId: string): HomeworkGradingState {
	return { ...state, activeStudentId: studentId }
}

export function loadHomeworkGradingState(storage: Storage | undefined): HomeworkGradingState {
	if (!storage) return createInitialHomeworkGradingState()
	try {
		const raw = storage.getItem(HOMEWORK_GRADING_STORAGE_KEY)
		if (!raw) return createInitialHomeworkGradingState()
		const parsed = JSON.parse(raw) as HomeworkGradingState
		if (!parsed.activeStudentId || !parsed.marksByStudent || !Array.isArray(parsed.transferLog)) {
			return createInitialHomeworkGradingState()
		}
		return parsed
	} catch {
		return createInitialHomeworkGradingState()
	}
}

export function saveHomeworkGradingState(storage: Storage | undefined, state: HomeworkGradingState): void {
	if (!storage) return
	storage.setItem(HOMEWORK_GRADING_STORAGE_KEY, JSON.stringify(state))
}

function updateStudentMarks(
	state: HomeworkGradingState,
	studentId: string,
	update: (marks: FeedbackMark[]) => FeedbackMark[],
): HomeworkGradingState {
	return {
		...state,
		marksByStudent: {
			...state.marksByStudent,
			[studentId]: update(state.marksByStudent[studentId] ?? []),
		},
	}
}
