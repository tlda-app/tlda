import { useEffect, useMemo, useState } from 'react'
import {
	addFeedbackMark,
	commitAttachedFeedback as commitAttachedFeedbackModel,
	currentStatus as studentCurrentStatus,
	HOMEWORK_STUDENTS,
	loadHomeworkGradingState,
	resetStudentMarks,
	returnedCount as studentReturnedCount,
	saveHomeworkGradingState,
	selectStudent as selectStudentModel,
	toggleFeedbackAttachment,
	type FeedbackStatus,
	type StoreId,
} from '../homework-grading/gradingStore'
import {
	createHomeworkGradingSurfaceRequest,
	type HomeworkGradingLayerScope,
	type HomeworkGradingPane,
	type HomeworkGradingRole,
} from '../wm/homework-grading-surface'
import './HomeworkGradingPrototype.css'

type ViewMode = 'instructor' | 'student'

interface GradingSurfaceModel {
	key: string
	pane: HomeworkGradingPane
	role: HomeworkGradingRole
	layerScope: HomeworkGradingLayerScope
	store: StoreId
	x: number
	y: number
	w: number
	h: number
}

const ASSIGNMENT_ID = 'hw7-bias-two-groups'
const PROBLEM_ID = 'problem-2a'
const SOURCE = 'teaching/qtm285-1/homework/hw7-bias-two-groups.qmd'
const OWNER = { userId: 'fleet:skip', deviceId: 'prototype-device' }

function storeLabel(store: StoreId): string {
	if (store === 'instructor-grading-store') return 'instructor grading store'
	if (store === 'student-accessible-store') return 'student-accessible store'
	return 'common class store'
}

function layerLabel(scope: HomeworkGradingLayerScope): string {
	if (scope === 'grading-draft') return 'grading draft'
	if (scope === 'returned-feedback') return 'returned feedback'
	return scope
}

function createSurface(model: GradingSurfaceModel, studentId: string) {
	return createHomeworkGradingSurfaceRequest({
		surfaceKey: model.key,
		bounds: { x: model.x, y: model.y, w: model.w, h: model.h },
		owner: OWNER,
		assignmentId: ASSIGNMENT_ID,
		problemId: PROBLEM_ID,
		studentId,
		role: model.role,
		pane: model.pane,
		layerScope: model.layerScope,
		source: SOURCE,
	})
}

function studentAnswerText(studentId: string) {
	if (studentId === 'student-b') {
		return {
			intro: 'The student gets the arithmetic right but leaves the grader to infer the mechanism.',
			choiceOne: 'The difference bias is small because both groups move toward 0.5.',
			choiceTwo: 'Opposite-direction priors make the regularized difference smaller.',
			math: '-0.0095 - (+0.0048) = -0.0143',
		}
	}
	if (studentId === 'student-c') {
		return {
			intro: 'This submission is loaded as a placeholder so the picker has an unopened state.',
			choiceOne: 'No grading marks yet.',
			choiceTwo: 'No grading marks yet.',
			math: 'awaiting review',
		}
	}
	return {
		intro: 'The student has the right setup but reverses the sign logic for choice 2.',
		choiceOne: 'Both groups are pulled down, so most of the bias cancels in the difference.',
		choiceTwo: 'Group 0 is pulled up and group 1 is pulled down, so the errors cancel each other out and the difference is still close.',
		math: '-0.0095 + (+0.0048) = -0.0047',
	}
}

export function HomeworkGradingPrototype() {
	const [viewMode, setViewMode] = useState<ViewMode>('instructor')
	const [activeLayer, setActiveLayer] = useState<HomeworkGradingLayerScope>('grading-draft')
	const [gradingState, setGradingState] = useState(() => loadHomeworkGradingState(typeof window === 'undefined' ? undefined : window.localStorage))
	const [studentMoved, setStudentMoved] = useState(false)
	const [newFeedbackTitle, setNewFeedbackTitle] = useState('')
	const [newFeedbackText, setNewFeedbackText] = useState('')

	useEffect(() => {
		saveHomeworkGradingState(typeof window === 'undefined' ? undefined : window.localStorage, gradingState)
	}, [gradingState])

	const activeStudent = HOMEWORK_STUDENTS.find((student) => student.id === gradingState.activeStudentId) ?? HOMEWORK_STUDENTS[0]
	const activeMarks = gradingState.marksByStudent[activeStudent.id] ?? []
	const primaryMark = activeMarks.find((mark) => mark.attached) ?? activeMarks[0]
	const currentStatus: FeedbackStatus = studentCurrentStatus(gradingState, activeStudent.id)
	const answer = studentAnswerText(activeStudent.id)

	const surfaces = useMemo<GradingSurfaceModel[]>(() => [
		{
			key: `${ASSIGNMENT_ID}/${activeStudent.id}/${PROBLEM_ID}/official`,
			pane: 'official-solution',
			role: 'instructor',
			layerScope: 'common',
			store: 'common-class-store',
			x: 40,
			y: 70,
			w: 500,
			h: 720,
		},
		{
			key: `${ASSIGNMENT_ID}/${activeStudent.id}/${PROBLEM_ID}/student`,
			pane: 'student-submission',
			role: viewMode,
			layerScope: 'student',
			store: 'student-accessible-store',
			x: 620,
			y: studentMoved ? 142 : 70,
			w: 500,
			h: 520,
		},
		{
			key: `${ASSIGNMENT_ID}/${activeStudent.id}/${PROBLEM_ID}/feedback`,
			pane: 'feedback',
			role: viewMode,
			layerScope: primaryMark?.layerScope ?? 'grading-draft',
			store: primaryMark?.store ?? 'instructor-grading-store',
			x: 760,
			y: studentMoved ? 382 : 310,
			w: 320,
			h: 120,
		},
	], [activeStudent.id, primaryMark?.layerScope, primaryMark?.store, studentMoved, viewMode])

	const wmRequests = useMemo(() => surfaces.map((surface) => createSurface(surface, activeStudent.id)), [activeStudent.id, surfaces])

	function toggleAttachment(markId: string) {
		setGradingState((state) => toggleFeedbackAttachment(state, activeStudent.id, markId))
	}

	function commitAttachedFeedback() {
		setGradingState((state) => commitAttachedFeedbackModel(state, activeStudent))
		setActiveLayer('student')
		setViewMode('student')
	}

	function resetStudent() {
		setGradingState((state) => resetStudentMarks(state, activeStudent.id))
		setActiveLayer('grading-draft')
		setViewMode('instructor')
		setStudentMoved(false)
	}

	function selectStudent(studentId: string) {
		setGradingState((state) => selectStudentModel(state, studentId))
		setViewMode('instructor')
		setActiveLayer('grading-draft')
		setStudentMoved(false)
	}

	function createFeedback() {
		setGradingState((state) => addFeedbackMark(state, activeStudent.id, {
			title: newFeedbackTitle,
			text: newFeedbackText,
			attached: true,
		}))
		setNewFeedbackTitle('')
		setNewFeedbackText('')
	}

	return (
		<div className={`homeworkPrototype ${viewMode === 'student' ? 'studentMode' : ''} ${currentStatus}`}>
			<aside className="hpSidebar">
				<div className="hpTitle">
					<h1>Homework Grading Workspace</h1>
					<p>HW7 Bias with Two Groups / Problem 2A</p>
				</div>

				<section className="hpControls">
					<div className="hpLabel">Viewer</div>
					<div className="hpSegmented hpTwo">
						<button className={viewMode === 'instructor' ? 'active' : ''} onClick={() => setViewMode('instructor')}>Instructor</button>
						<button className={viewMode === 'student' ? 'active' : ''} onClick={() => setViewMode('student')}>Student</button>
					</div>
				</section>

				<section className="hpControls">
					<div className="hpLabel">Active layer</div>
					<div className="hpLayerGrid">
						{(['common', 'mine', 'student', 'grading-draft'] as HomeworkGradingLayerScope[]).map((layer) => (
							<button key={layer} className={activeLayer === layer ? 'active' : ''} onClick={() => setActiveLayer(layer)}>
								{layerLabel(layer)}
							</button>
						))}
					</div>
				</section>

				<section className="hpControls">
					<div className="hpLabel">Store transfer</div>
					<div className="hpStoreFlow">
						<div><strong>Draft</strong><span>instructor grading store</span></div>
						<div><strong>Commit</strong><span>attached feedback objects transfer</span></div>
						<div><strong>Returned</strong><span>student-accessible store</span></div>
					</div>
				</section>

				<section className="hpControls">
					<div className="hpLabel">Submissions</div>
					<div className="hpStudentList">
						{HOMEWORK_STUDENTS.map((student) => {
							const count = studentReturnedCount(gradingState, student.id)
							const status = studentCurrentStatus(gradingState, student.id)
							return (
								<button key={student.id} className={student.id === activeStudent.id ? 'active' : ''} onClick={() => selectStudent(student.id)}>
									<span>{student.name}</span>
									<small>{student.summary}</small>
									<span className={`hpTag ${status}`}>{status}{count > 0 ? ` ${count}` : ''}</span>
								</button>
							)
						})}
					</div>
				</section>

				<section className="hpControls">
					<div className="hpLabel">Feedback objects</div>
					<div className="hpMarkList">
						{activeMarks.map((mark) => (
							<label key={mark.id} className={`hpMarkRow ${mark.status}`}>
								<input
									type="checkbox"
									checked={mark.attached}
									disabled={mark.status === 'returned'}
									onChange={() => toggleAttachment(mark.id)}
								/>
								<span>{mark.title}</span>
								<small>{storeLabel(mark.store)}</small>
							</label>
						))}
					</div>
				</section>

				<section className="hpControls">
					<div className="hpLabel">New feedback</div>
					<div className="hpNewFeedback">
						<input
							value={newFeedbackTitle}
							onChange={(event) => setNewFeedbackTitle(event.target.value)}
							placeholder="Short label"
						/>
						<textarea
							value={newFeedbackText}
							onChange={(event) => setNewFeedbackText(event.target.value)}
							placeholder="Feedback text"
							rows={3}
						/>
						<button onClick={createFeedback}>Add attached draft</button>
					</div>
				</section>

				<section className="hpActions">
					<button className="primary" onClick={commitAttachedFeedback}>Commit attached feedback</button>
					<button onClick={() => setStudentMoved((value) => !value)}>Move student submission</button>
					<button onClick={resetStudent}>Reset this student</button>
				</section>
			</aside>

			<main className="hpMain">
				<header className="hpTopbar">
					<div>
						<strong>WM-managed grading workspace</strong>
						<span>{SOURCE}</span>
					</div>
					<div className="hpStatus">
						<span className="hpDot" />
						<span>{currentStatus}</span>
						<span>{storeLabel(primaryMark?.store ?? 'instructor-grading-store')}</span>
					</div>
				</header>

				<section className="hpWorkspace" aria-label="Homework grading workspace">
					<div className="hpCanvas">
						<article className="hpPane hpOfficial">
							<div className="hpPaneHeader">
								<h2>Official solution</h2>
								<span>common class store</span>
							</div>
							<div className="hpPaper">
								<p>Suppose mu(0) = 0.6 and mu(1) = 0.7, so the true difference is 0.1. Compare same-prior and different-prior regularization.</p>
								<div className="hpCallout official">
									<h3>Choice 1: Same prior</h3>
									<p>Both biases are negative. Both means get pulled down toward 0.5.</p>
									<pre>{`bias[mu_tilde(0)] = 10(0.5 - 0.6) / 210 = -0.0048
bias[mu_tilde(1)] = 10(0.5 - 0.7) / 210 = -0.0095`}</pre>
									<p>The bias of the difference is -0.0095 - (-0.0048) = -0.0048.</p>
								</div>
								<div className="hpCallout official">
									<h3>Choice 2: Different priors</h3>
									<p>Group 0 gets pulled up; group 1 gets pulled down.</p>
									<pre>{`bias[mu_tilde(0)] = 10(0.7 - 0.6) / 210 = +0.0048
bias[mu_tilde(1)] = 10(0.5 - 0.7) / 210 = -0.0095`}</pre>
									<p>The bias of the difference is -0.0095 - (+0.0048) = -0.0143.</p>
								</div>
							</div>
						</article>

						{primaryMark?.attached ? (
							<div className={`hpArrow ${primaryMark.status}`} aria-hidden="true">
								<svg viewBox="0 0 150 80">
									<path d="M8 16 C50 4, 88 60, 140 48" />
									<path d="M129 39 L142 48 L128 56" />
								</svg>
							</div>
						) : null}

						<article className={`hpPane hpStudent ${studentMoved ? 'moved' : ''}`} id="prototypeStudentPane">
							<div className="hpPaneHeader">
								<h2>{activeStudent.name} submission</h2>
								<span>student-accessible store</span>
							</div>
							<div className="hpPaper">
								<p>{answer.intro}</p>
								<div className="hpCallout student">
									<h3>Student answer: Choice 1</h3>
									<p>{answer.choiceOne}</p>
									<pre>-0.0095 - (-0.0048) = -0.0047</pre>
								</div>
								<div className="hpCallout student">
									<h3>Student answer: Choice 2</h3>
									<p><mark>{answer.choiceTwo}</mark></p>
									<pre>{answer.math}</pre>
								</div>
							</div>
							{activeMarks.map((mark, index) => (
								<aside
									key={mark.id}
									className={`hpFeedbackCard ${mark.status} ${mark.attached ? 'attached' : 'loose'}`}
									id={index === 0 ? 'prototypeFeedbackCard' : undefined}
									style={{ top: `${245 + index * 132}px` }}
								>
									<strong>{mark.title}</strong>
									<span>{mark.text}</span>
									<small>{storeLabel(mark.store)} / {layerLabel(mark.layerScope)}</small>
								</aside>
							))}
						</article>
					</div>
				</section>

				<section className="hpInspector" aria-label="WM surface inspector">
					<div className="hpInspectorHeader">
						<strong>WM surface requests</strong>
						<span>generated from src/wm/homework-grading-surface.ts</span>
					</div>
					<div className="hpSurfaceGrid">
						{wmRequests.map((request, index) => (
							<div className="hpSurfaceCard" key={request.surfaceId}>
								<strong>{request.payload.pane}</strong>
								<span>{request.surfaceId}</span>
								<span>{request.layerId}</span>
								<span>{storeLabel(surfaces[index]?.store ?? 'common-class-store')}</span>
								<code>{request.payload.layerScope}</code>
							</div>
						))}
					</div>
					<div className="hpTransferLog">
						<strong>Transfer log</strong>
						{gradingState.transferLog.length === 0 ? (
							<span>No committed feedback transfers yet.</span>
						) : gradingState.transferLog.map((event) => (
							<span key={event.id}>{event.studentName}: {event.markTitle} moved from {storeLabel(event.from)} to {storeLabel(event.to)}</span>
						))}
					</div>
				</section>
			</main>
		</div>
	)
}
