import type { Editor, TLViewportId } from 'tldraw'
import { createWMCore, type Camera, type LayerDefinition, type WMCore } from './wm-core.ts'

export const EDITOR_WM_ROOT_LAYER_ID = 'screen'

interface EditorWMState {
	id: string
	wm: WMCore
	viewportLayers: Map<string, RegisteredViewportLayer>
	coordinateTraces: CoordinateTrace[]
}

export interface RegisteredViewportLayer {
	viewportId: TLViewportId
	wm: WMCore
	frameLayerId: string
	coordinateLayerId: string
	surfaceLayerId?: string
	readFrame?: () => { x: number; y: number; scale: number }
}

export function refreshViewportFrame(registration: RegisteredViewportLayer) {
	const frame = registration.readFrame?.()
	if (!frame) return
	registration.wm.setTransform(registration.frameLayerId, frame)
}

export interface CoordinateTrace {
	fn: 'clientPointToPage' | 'pagePointToClient'
	viewportId?: string
	path: 'wm' | 'fallback' | 'main'
	layerId?: string
	point: { x: number; y: number }
	result: { x: number; y: number }
}

interface EditorWMGlobals {
	editorStates: WeakMap<Editor, EditorWMState>
	viewportLayers: Map<string, RegisteredViewportLayer>
	nextCoreId: number
}

const globals = (() => {
	const globalKey = '__tlda_wm_editor_globals__'
	const scope = globalThis as typeof globalThis & { [globalKey]?: EditorWMGlobals }
	scope[globalKey] ??= {
		editorStates: new WeakMap<Editor, EditorWMState>(),
		viewportLayers: new Map<string, RegisteredViewportLayer>(),
		nextCoreId: 1,
	}
	return scope[globalKey]
})()

const editorStates = globals.editorStates
const globalViewportLayers = globals.viewportLayers

function exposeState(state: EditorWMState) {
	if (typeof window === 'undefined') return
	const w = window as unknown as {
		__tlda_wm_core__?: unknown
		__tlda_wm_coordinate_traces__?: CoordinateTrace[]
	}
	w.__tlda_wm_core__ = {
		id: state.id,
		wm: state.wm,
		viewportIds: [...state.viewportLayers.keys()],
		viewports: [...state.viewportLayers.values()].map((registration) => ({
			viewportId: registration.viewportId,
			frameLayerId: registration.frameLayerId,
			coordinateLayerId: registration.coordinateLayerId,
			surfaceLayerId: registration.surfaceLayerId,
		})),
		layerCount: state.wm.layerCount(),
	}
	w.__tlda_wm_coordinate_traces__ = state.coordinateTraces
}

export function getEditorWMState(editor: Editor): EditorWMState {
	let state = editorStates.get(editor)
	if (!state) {
		state = {
			id: `editor-wm-${globals.nextCoreId++}`,
			wm: createWMCore({ rootLayerId: EDITOR_WM_ROOT_LAYER_ID }),
			viewportLayers: new Map(),
			coordinateTraces: [],
		}
		editorStates.set(editor, state)
	}
	exposeState(state)
	return state
}

export function getEditorWMCore(editor: Editor): WMCore {
	return getEditorWMState(editor).wm
}

export function ensureLayer(wm: WMCore, id: string, definition: LayerDefinition = {}) {
	return wm.defineOrUpdateLayer(id, definition)
}

export function removeLayers(wm: WMCore, layerIds: string[]) {
	for (const id of layerIds) {
		if (!wm.hasLayer(id)) continue
		wm.removeLayer(id)
	}
}

export function viewportFrameLayerId(viewportId: TLViewportId) {
	return `wm:viewport-frame:${viewportId}`
}

export function viewportCoordinateLayerId(viewportId: TLViewportId) {
	return `wm:viewport-camera:${viewportId}`
}

export function registerViewportLayer(editor: Editor, registration: RegisteredViewportLayer) {
	const state = getEditorWMState(editor)
	state.viewportLayers.set(registration.viewportId, registration)
	globalViewportLayers.set(registration.viewportId, registration)
	exposeState(state)
}

export function unregisterViewportLayer(editor: Editor, viewportId: TLViewportId, registration: RegisteredViewportLayer) {
	const state = getEditorWMState(editor)
	if (state.viewportLayers.get(viewportId) === registration) {
		state.viewportLayers.delete(viewportId)
		if (globalViewportLayers.get(viewportId) === registration) {
			globalViewportLayers.delete(viewportId)
		}
		exposeState(state)
	}
}

export function getRegisteredViewportLayer(editor: Editor, viewportId: TLViewportId) {
	return getEditorWMState(editor).viewportLayers.get(viewportId) ?? globalViewportLayers.get(viewportId)
}

export function recordCoordinateTrace(editor: Editor, trace: CoordinateTrace) {
	const state = getEditorWMState(editor)
	state.coordinateTraces.push(trace)
	if (state.coordinateTraces.length > 100) state.coordinateTraces.shift()
	exposeState(state)
}

export function cameraToCoordinateTransform(camera: Camera) {
	return {
		x: camera.x * camera.z,
		y: camera.y * camera.z,
		scale: camera.z,
	}
}
