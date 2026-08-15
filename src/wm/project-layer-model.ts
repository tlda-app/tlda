import type { Editor } from 'tldraw'
import { createLayerModel, type SerializedLayerModel } from '../../packages/tldraw-wm/src/layer-model.ts'
import type { LayerModel } from '../../packages/tldraw-wm/src/layer-model.ts'
import { bindEditorLayerModel, EDITOR_WM_ROOT_LAYER_ID } from './editor-wm.ts'

export const PROJECT_LAYER_MODEL_SHAPE_ID = 'shape:wm-project-layer-model'
const META_KEY = 'wmLayerModel'

function snapshotFromShape(editor: Editor): SerializedLayerModel | null {
	const value = (editor.getShape(PROJECT_LAYER_MODEL_SHAPE_ID as never)?.meta as Record<string, unknown> | undefined)?.[META_KEY]
	if (!value || typeof value !== 'object') return null
	const snapshot = value as Partial<SerializedLayerModel>
	if (snapshot.version !== 1 || snapshot.rootLayerId !== EDITOR_WM_ROOT_LAYER_ID || !Array.isArray(snapshot.layers)) return null
	return snapshot as SerializedLayerModel
}

export function reconcileProjectLayerSnapshot(model: LayerModel, snapshot: SerializedLayerModel): SerializedLayerModel | null {
	if (JSON.stringify(snapshot) === JSON.stringify(model.serialize())) return null
	model.reconcile(snapshot)
	const resolved = model.serialize()
	return JSON.stringify(resolved) === JSON.stringify(snapshot) ? null : resolved
}

/** Bind project layer semantics to a hidden document record in the synced
 * tldraw store. The store is the production Yjs/load/save wire; cameras and
 * viewport registrations remain editor-local and never enter the record. */
export function installProjectLayerModel(editor: Editor): () => void {
	const initial = snapshotFromShape(editor) ?? {
		version: 1 as const,
		rootLayerId: EDITOR_WM_ROOT_LAYER_ID,
		revision: 0,
		layers: [],
	}
	const model = bindEditorLayerModel(editor, createLayerModel(initial, { actorId: editor.id }))

	let writing = false
	let applyingRemote = false
	const write = (snapshot: SerializedLayerModel) => {
		if (applyingRemote) return
		const current = snapshotFromShape(editor)
		if (current && JSON.stringify(current) === JSON.stringify(snapshot)) return
		writing = true
		try {
			editor.run(() => {
				const existing = editor.getShape(PROJECT_LAYER_MODEL_SHAPE_ID as never)
				if (existing) {
					editor.updateShape({
						id: PROJECT_LAYER_MODEL_SHAPE_ID as never,
						type: 'geo',
						meta: { ...existing.meta, [META_KEY]: snapshot },
					} as never)
				} else {
					editor.createShape({
						id: PROJECT_LAYER_MODEL_SHAPE_ID as never,
						type: 'geo',
						x: 0,
						y: 0,
						opacity: 0,
						isLocked: true,
						props: { w: 1, h: 1, geo: 'rectangle' },
						meta: { [META_KEY]: snapshot },
					} as never)
				}
			}, { history: 'ignore', ignoreShapeLock: true })
		} finally {
			writing = false
		}
	}

	const stopModel = model.subscribe(write)
	const stopStore = editor.store.listen(({ changes }) => {
		if (writing) return
		const changed = PROJECT_LAYER_MODEL_SHAPE_ID in changes.added || PROJECT_LAYER_MODEL_SHAPE_ID in changes.updated
		if (!changed) return
		const snapshot = snapshotFromShape(editor)
		if (snapshot && JSON.stringify(snapshot) !== JSON.stringify(model.serialize())) {
			applyingRemote = true
			let winner: SerializedLayerModel | null = null
			try { winner = reconcileProjectLayerSnapshot(model, snapshot) } finally { applyingRemote = false }
			if (winner) write(winner)
		}
	}, { source: 'all', scope: 'document' })
	write(model.serialize())

	return () => {
		stopStore()
		stopModel()
	}
}
