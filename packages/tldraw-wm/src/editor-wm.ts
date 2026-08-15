import type { Editor, TLViewportId } from 'tldraw'
import { createWMCore, type Camera, type LayerDefinition, type WMCore } from './wm-core.ts'
import { createLayerModel, type LayerModel, type SerializedLayerModel } from './layer-model.ts'

export const EDITOR_WM_ROOT_LAYER_ID = 'screen'

interface EditorWMState {
	id: string
	wm: WMCore
	layerModel: LayerModel
	viewportLayers: Map<string, RegisteredViewportLayer>
	coordinateTraces: CoordinateTrace[]
	appliedSemanticLayerIds: Set<string>
	stopLayerModelSubscription?: () => void
	/** Host-supplied readout of shape membership, published for inspection. The
	 *  core cannot enumerate a host's store, so the host hands it in. */
	shapeLayerReport?: () => unknown
}

export interface EditorWMView {
	id: string
	layerModel: LayerModel
	wm: WMCore
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
	projectModels: WeakMap<object, LayerModel>
	coreStates: WeakMap<WMCore, EditorWMState>
	nextCoreId: number
}

const globals = (() => {
	const globalKey = '__tldraw_wm_editor_globals__'
	const scope = globalThis as typeof globalThis & { [globalKey]?: EditorWMGlobals }
	scope[globalKey] ??= {
		editorStates: new WeakMap<Editor, EditorWMState>(),
		projectModels: new WeakMap<object, LayerModel>(),
		coreStates: new WeakMap<WMCore, EditorWMState>(),
		nextCoreId: 1,
	}
	scope[globalKey].projectModels ??= new WeakMap<object, LayerModel>()
	scope[globalKey].coreStates ??= new WeakMap<WMCore, EditorWMState>()
	return scope[globalKey]
})()

const editorStates = globals.editorStates
const projectModels = globals.projectModels
const coreStates = globals.coreStates

export interface EditorWMDiagnostics {
	id: string
	wm: WMCore
	layerModel: SerializedLayerModel
	viewportIds: string[]
	viewports: Array<Pick<RegisteredViewportLayer, 'viewportId' | 'frameLayerId' | 'coordinateLayerId' | 'surfaceLayerId'>>
	coordinateTraces: CoordinateTrace[]
	layerIdOfShape: (shape: unknown) => string
	shapeLayerReport?: () => unknown
}

let diagnosticsSink: ((diagnostics: EditorWMDiagnostics) => void) | null = null

export function setEditorWMDiagnosticsSink(sink: ((diagnostics: EditorWMDiagnostics) => void) | null) {
	diagnosticsSink = sink
}

function exposeState(state: EditorWMState) {
	diagnosticsSink?.({
		id: state.id,
		wm: state.wm,
		layerModel: state.layerModel.serialize(),
		viewportIds: [...state.viewportLayers.keys()],
		viewports: [...state.viewportLayers.values()].map((registration) => ({
			viewportId: registration.viewportId,
			frameLayerId: registration.frameLayerId,
			coordinateLayerId: registration.coordinateLayerId,
			surfaceLayerId: registration.surfaceLayerId,
		})),
		layerIdOfShape: (shape: unknown) => state.wm.layerIdOfShape(shape),
		shapeLayerReport: state.shapeLayerReport,
		coordinateTraces: state.coordinateTraces,
	})
}

function projectKey(editor: Editor): object {
	const store = (editor as Editor & { store?: object }).store
	return store && typeof store === 'object' ? store : editor
}

function getOrCreateProjectLayerModel(editor: Editor): LayerModel {
	const key = projectKey(editor)
	let model = projectModels.get(key)
	if (!model) {
		model = createLayerModel({ rootLayerId: EDITOR_WM_ROOT_LAYER_ID, layers: [] })
		projectModels.set(key, model)
	}
	return model
}

function applySemanticModel(state: EditorWMState) {
	const layers = state.layerModel.values()
	const nextIds = new Set(layers.map(layer => layer.id))
	const staleIds = [...state.appliedSemanticLayerIds].filter(id => !nextIds.has(id))
	for (const id of staleIds.reverse()) {
		if (state.wm.hasLayer(id)) state.wm.removeLayer(id)
	}
	for (const layer of layers) {
		state.wm.defineOrUpdateLayer(layer.id, {
			parent: layer.parent,
			policy: layer.policy,
			cameraPanUnit: layer.cameraPanUnit,
			layout: layer.layout,
		})
	}
	state.appliedSemanticLayerIds = nextIds
	exposeState(state)
}

export function setShapeLayerReport(editor: Editor, report: () => unknown) {
	const state = getEditorWMState(editor)
	state.shapeLayerReport = report
	exposeState(state)
}

export function getEditorWMState(editor: Editor): EditorWMState {
	let state = editorStates.get(editor)
	if (!state) {
		const layerModel = getOrCreateProjectLayerModel(editor)
		const wm = createWMCore({ rootLayerId: EDITOR_WM_ROOT_LAYER_ID })
		state = {
			id: `editor-wm-${globals.nextCoreId++}`,
			wm,
			layerModel,
			viewportLayers: new Map(),
			coordinateTraces: [],
			appliedSemanticLayerIds: new Set(),
		}
		editorStates.set(editor, state)
		coreStates.set(wm, state)
		state.stopLayerModelSubscription = layerModel.subscribe(() => applySemanticModel(state!))
		applySemanticModel(state)
	}
	exposeState(state)
	return state
}

export function getEditorWMCore(editor: Editor): WMCore {
	return getEditorWMState(editor).wm
}

export function getEditorWMView(editor: Editor): EditorWMView {
	const state = getEditorWMState(editor)
	return { id: state.id, layerModel: state.layerModel, wm: state.wm }
}

export function getEditorLayerModel(editor: Editor): LayerModel {
	return getEditorWMState(editor).layerModel
}

/** Attach a host-hydrated project model before creating this editor's view. */
export function bindEditorLayerModel(editor: Editor, layerModel: LayerModel): LayerModel {
	const existing = editorStates.get(editor)
	if (existing && existing.layerModel !== layerModel) {
		if (existing.layerModel.values().length > 0) {
			existing.layerModel.reconcile(layerModel.serialize())
			return existing.layerModel
		}
		existing.stopLayerModelSubscription?.()
		existing.layerModel = layerModel
		existing.stopLayerModelSubscription = layerModel.subscribe(() => applySemanticModel(existing))
		applySemanticModel(existing)
	}
	projectModels.set(projectKey(editor), layerModel)
	return existing?.layerModel ?? layerModel
}

export function ensureLayer(wm: WMCore, id: string, definition: LayerDefinition = {}) {
	const state = coreStates.get(wm)
	if (!state) return wm.defineOrUpdateLayer(id, definition)
	state.layerModel.defineOrUpdate({
		id,
		parent: definition.parent,
		policy: definition.policy,
		cameraPanUnit: definition.cameraPanUnit,
		layout: definition.layout,
	})
	return wm.defineOrUpdateLayer(id, {
		transform: definition.transform,
		camera: definition.camera,
		backing: definition.backing,
	})
}

/** Editor-local layers are viewport/frame state and never enter the project model. */
export function ensureViewLayer(wm: WMCore, id: string, definition: LayerDefinition = {}) {
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
	if (registration.wm !== state.wm) {
		throw new Error(`Viewport "${registration.viewportId}" must be registered with its editor's WM core.`)
	}
	state.viewportLayers.set(registration.viewportId, registration)
	exposeState(state)
}

export function unregisterViewportLayer(editor: Editor, viewportId: TLViewportId, registration: RegisteredViewportLayer) {
	const state = getEditorWMState(editor)
	if (state.viewportLayers.get(viewportId) === registration) {
		state.viewportLayers.delete(viewportId)
		exposeState(state)
	}
}

export function getRegisteredViewportLayer(editor: Editor, viewportId: TLViewportId) {
	return getEditorWMState(editor).viewportLayers.get(viewportId)
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
