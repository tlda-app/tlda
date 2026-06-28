import type { Editor, TLViewportId } from 'tldraw'
import type { Point } from './wm-core.ts'
import {
	EDITOR_WM_ROOT_LAYER_ID,
	getRegisteredViewportLayer,
	recordCoordinateTrace,
	refreshViewportFrame,
} from './editor-wm.ts'

function clonePoint(point: { x: number; y: number }): Point {
	return { x: point.x, y: point.y }
}

export function clientPointToPage(
	editor: Editor,
	point: { x: number; y: number },
	viewportId?: TLViewportId,
) {
	if (!viewportId) {
		const result = editor.screenToPage(point)
		recordCoordinateTrace(editor, { fn: 'clientPointToPage', path: 'main', point, result })
		return result
	}

	const registered = getRegisteredViewportLayer(editor, viewportId)
	if (registered) {
		refreshViewportFrame(registered)
		const result = registered.wm.translate(
			clonePoint(point),
			EDITOR_WM_ROOT_LAYER_ID,
			registered.coordinateLayerId,
		)
		recordCoordinateTrace(editor, {
			fn: 'clientPointToPage',
			viewportId,
			path: 'wm',
			layerId: registered.coordinateLayerId,
			point,
			result,
		})
		return result
	}

	const result = editor.screenToPage(point, { viewportId })
	recordCoordinateTrace(editor, { fn: 'clientPointToPage', viewportId, path: 'fallback', point, result })
	return result
}

export function pagePointToClient(
	editor: Editor,
	point: { x: number; y: number },
	viewportId?: TLViewportId,
) {
	if (!viewportId) {
		const result = editor.pageToScreen(point)
		recordCoordinateTrace(editor, { fn: 'pagePointToClient', path: 'main', point, result })
		return result
	}

	const registered = getRegisteredViewportLayer(editor, viewportId)
	if (registered) {
		refreshViewportFrame(registered)
		const result = registered.wm.translate(
			clonePoint(point),
			registered.coordinateLayerId,
			EDITOR_WM_ROOT_LAYER_ID,
		)
		recordCoordinateTrace(editor, {
			fn: 'pagePointToClient',
			viewportId,
			path: 'wm',
			layerId: registered.coordinateLayerId,
			point,
			result,
		})
		return result
	}

	const result = editor.pageToScreen(point, { viewportId })
	recordCoordinateTrace(editor, { fn: 'pagePointToClient', viewportId, path: 'fallback', point, result })
	return result
}

export function pagePointToPage(
	editor: Editor,
	point: { x: number; y: number },
	fromViewportId?: TLViewportId,
	toViewportId?: TLViewportId,
) {
	const clientPoint = pagePointToClient(editor, point, fromViewportId)
	return clientPointToPage(editor, clientPoint, toViewportId)
}

if (typeof window !== 'undefined') {
	const w = window as unknown as {
		__tlda_wm_coordinates__?: {
			clientPointToPage: typeof clientPointToPage
			pagePointToClient: typeof pagePointToClient
			pagePointToPage: typeof pagePointToPage
		}
	}
	w.__tlda_wm_coordinates__ = {
		clientPointToPage,
		pagePointToClient,
		pagePointToPage,
	}
}
