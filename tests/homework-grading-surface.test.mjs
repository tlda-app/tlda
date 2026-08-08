import assert from 'node:assert/strict'
import test from 'node:test'

import {
	createHomeworkGradingSurfaceRequest,
	homeworkGradingShapeMeta,
} from '../src/wm/homework-grading-surface.ts'

const baseInput = {
	surfaceKey: 'hw7/student-a/problem-2a',
	bounds: { x: 120, y: 80, w: 920, h: 540 },
	owner: { userId: 'fleet:skip', deviceId: 'ipad' },
	assignmentId: 'hw7-bias-two-groups',
	problemId: 'problem-2a',
	studentId: 'student-a',
	role: 'instructor',
	pane: 'student-submission',
	layerScope: 'grading-draft',
	source: 'teaching/qtm285-1/homework/hw7-bias-two-groups.qmd',
}

test('homework grading surface records assignment, student, pane, and layer scope in WM metadata', () => {
	const request = createHomeworkGradingSurfaceRequest(baseInput)
	const meta = homeworkGradingShapeMeta(request)

	assert.equal(request.kind, 'homework-grading')
	assert.equal(request.surfaceId, 'homework-grading:hw7-student-a-problem-2a')
	assert.equal(request.layerId, 'homework-grading-layer:hw7-bias-two-groups:student-a:grading-draft')
	assert.deepEqual(request.owner, { userId: 'fleet:skip', deviceId: 'ipad' })
	assert.equal(request.hitPolicy, 'chrome-catches-content-pans')
	assert.equal(request.payload.assignmentId, 'hw7-bias-two-groups')
	assert.equal(request.payload.problemId, 'problem-2a')
	assert.equal(request.payload.studentId, 'student-a')
	assert.equal(request.payload.pane, 'student-submission')
	assert.equal(request.payload.layerScope, 'grading-draft')
	assert.equal(meta.managedKind, 'homework-grading')
	assert.equal(meta.managedLayerId, 'homework-grading-layer:hw7-bias-two-groups:student-a:grading-draft')
	assert.equal(meta.managedCoordinateSpace, 'canvas-page')
})

test('homework grading surfaces require an owner because grading layers are per user/device', () => {
	assert.throws(
		() => createHomeworkGradingSurfaceRequest({ ...baseInput, owner: { userId: 'fleet:skip' } }),
		/managed homework grading surface requires owner userId and deviceId/,
	)
})
