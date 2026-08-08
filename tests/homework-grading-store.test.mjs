import assert from 'node:assert/strict'
import test from 'node:test'

import {
	addFeedbackMark,
	commitAttachedFeedback,
	createInitialHomeworkGradingState,
	HOMEWORK_STUDENTS,
	resetStudentMarks,
	toggleFeedbackAttachment,
} from '../src/homework-grading/gradingStore.ts'

test('commit transfers only attached draft feedback into student-accessible store', () => {
	const student = HOMEWORK_STUDENTS[0]
	let state = createInitialHomeworkGradingState(student.id)
	state = toggleFeedbackAttachment(state, student.id, 'explanation-feedback')
	state = commitAttachedFeedback(state, student, 10)

	const marks = state.marksByStudent[student.id]
	assert.equal(marks.length, 2)
	assert.equal(marks.every((mark) => mark.status === 'returned'), true)
	assert.equal(marks.every((mark) => mark.store === 'student-accessible-store'), true)
	assert.equal(marks.every((mark) => mark.layerScope === 'returned-feedback'), true)
	assert.equal(state.transferLog.length, 2)
	assert.deepEqual(state.transferLog.map((event) => event.markTitle), [
		'Check the sign here.',
		'Add the cancellation sentence.',
	])
})

test('unattached feedback stays in instructor grading store', () => {
	const student = HOMEWORK_STUDENTS[0]
	const state = commitAttachedFeedback(createInitialHomeworkGradingState(student.id), student, 20)
	const marks = state.marksByStudent[student.id]

	assert.equal(marks[0].status, 'returned')
	assert.equal(marks[0].store, 'student-accessible-store')
	assert.equal(marks[1].status, 'draft')
	assert.equal(marks[1].store, 'instructor-grading-store')
	assert.equal(state.transferLog.length, 1)
})

test('students maintain independent returned state', () => {
	const studentA = HOMEWORK_STUDENTS[0]
	const studentB = HOMEWORK_STUDENTS[1]
	let state = createInitialHomeworkGradingState(studentA.id)
	state = commitAttachedFeedback(state, studentA, 30)

	assert.equal(state.marksByStudent[studentA.id].filter((mark) => mark.status === 'returned').length, 1)
	assert.equal(state.marksByStudent[studentB.id].filter((mark) => mark.status === 'returned').length, 0)
})

test('new feedback starts as an attached instructor draft and can be reset', () => {
	const student = HOMEWORK_STUDENTS[0]
	let state = createInitialHomeworkGradingState(student.id)
	state = addFeedbackMark(state, student.id, { title: 'New note', text: 'Explain the cancellation.' })

	const added = state.marksByStudent[student.id].at(-1)
	assert.equal(added.title, 'New note')
	assert.equal(added.attached, true)
	assert.equal(added.status, 'draft')
	assert.equal(added.store, 'instructor-grading-store')

	state = resetStudentMarks(state, student.id)
	assert.equal(state.marksByStudent[student.id].some((mark) => mark.title === 'New note'), false)
})
