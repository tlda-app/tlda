import type { JsonObject } from '@tldraw/utils'
import {
	managedSurfaceShapeMeta,
	requireManagedSurfaceOwner,
	surfaceSlug,
	type ManagedSurfaceOwner,
	type ManagedSurfaceRect,
	type ManagedSurfaceRequest,
} from './managed-surfaces.ts'
import type { TldaManagedSurfaceKind } from './tlda-managed-surface-kinds.ts'

export const HOMEWORK_GRADING_SURFACE_PREFIX = 'homework-grading'
export const HOMEWORK_GRADING_LAYER_PREFIX = 'homework-grading-layer'
export type HomeworkGradingSurfaceKind = Extract<TldaManagedSurfaceKind, typeof HOMEWORK_GRADING_SURFACE_PREFIX>

export type HomeworkGradingRole = 'instructor' | 'student'
export type HomeworkGradingPane = 'official-solution' | 'student-submission' | 'feedback'
export type HomeworkGradingLayerScope =
	| 'common'
	| 'mine'
	| 'student'
	| 'grading-draft'
	| 'returned-feedback'

export interface HomeworkGradingSurfaceInput {
	surfaceKey: string
	bounds: ManagedSurfaceRect
	owner?: Partial<ManagedSurfaceOwner>
	assignmentId: string
	problemId: string
	studentId: string
	role: HomeworkGradingRole
	pane: HomeworkGradingPane
	layerScope: HomeworkGradingLayerScope
	source: string
}

export interface HomeworkGradingSurfacePayload {
	assignmentId: string
	problemId: string
	studentId: string
	role: HomeworkGradingRole
	pane: HomeworkGradingPane
	layerScope: HomeworkGradingLayerScope
	coordinateSpace: 'canvas-page'
	source: string
}

function homeworkGradingLayerId({
	assignmentId,
	studentId,
	layerScope,
}: Pick<HomeworkGradingSurfaceInput, 'assignmentId' | 'studentId' | 'layerScope'>): string {
	return [
		HOMEWORK_GRADING_LAYER_PREFIX,
		surfaceSlug(assignmentId),
		surfaceSlug(studentId),
		surfaceSlug(layerScope),
	].join(':')
}

export function createHomeworkGradingSurfaceRequest({
	surfaceKey,
	bounds,
	owner,
	assignmentId,
	problemId,
	studentId,
	role,
	pane,
	layerScope,
	source,
}: HomeworkGradingSurfaceInput): ManagedSurfaceRequest<HomeworkGradingSurfacePayload, HomeworkGradingSurfaceKind> {
	const slug = surfaceSlug(surfaceKey)
	const resolvedOwner = requireManagedSurfaceOwner(owner, 'managed homework grading surface')
	return {
		kind: HOMEWORK_GRADING_SURFACE_PREFIX,
		surfaceId: `${HOMEWORK_GRADING_SURFACE_PREFIX}:${slug}`,
		layerId: homeworkGradingLayerId({ assignmentId, studentId, layerScope }),
		owner: resolvedOwner,
		extent: { ...bounds },
		placement: { mode: 'page', left: bounds.x, top: bounds.y, margin: 0 },
		cameraPolicy: { x: 'pan', y: 'pan', zoom: 'inherit' },
		hitPolicy: 'chrome-catches-content-pans',
		cleanup: {
			onClose: 'remove-surface',
			onReplace: 'replace-existing-surface',
			onOwnerChange: 'remove-surface',
		},
		// 'room', not 'session': marking a class is not one sitting, and the
		// feedback on a submission outlives the tab that drew it. Nothing reads
		// this field today — it is serialised into shape metadata and never
		// consumed — so this changes no behaviour. It is here so the declaration
		// is not lying when something does read it.
		persistence: { pinned: false, scope: 'room' },
		source,
		payload: {
			assignmentId,
			problemId,
			studentId,
			role,
			pane,
			layerScope,
			coordinateSpace: 'canvas-page',
			source,
		},
	}
}

export function homeworkGradingShapeMeta(
	request: ManagedSurfaceRequest<HomeworkGradingSurfacePayload, HomeworkGradingSurfaceKind>,
): JsonObject {
	return managedSurfaceShapeMeta(request, { coordinateSpace: request.payload.coordinateSpace })
}
