import type { LayerId, LayerLayout, TrackPolicy } from './wm-core.ts'

export interface SemanticLayerDefinition {
	id: LayerId
	parent: LayerId
	policy: TrackPolicy
	cameraPanUnit: 'layer' | 'screen'
	layout?: LayerLayout
}

export interface SerializedLayerModel {
	version: 1
	rootLayerId: LayerId
	revision: number
	writerId?: string
	layers: SemanticLayerDefinition[]
}

type LayerModelListener = (snapshot: SerializedLayerModel) => void

const DEFAULT_POLICY: TrackPolicy = { x: 'pan', y: 'pan', zoom: 'inherit' }

function cloneDefinition(layer: SemanticLayerDefinition): SemanticLayerDefinition {
	const clone: SemanticLayerDefinition = {
		id: layer.id,
		parent: layer.parent,
		policy: { ...layer.policy },
		cameraPanUnit: layer.cameraPanUnit,
	}
	if (layer.layout) clone.layout = { ...layer.layout }
	return clone
}

/** Project-owned, serializable layer semantics. Cameras, viewport registrations,
 * DOM frames, and editor adapters deliberately do not fit in this model. */
export class LayerModel {
	readonly rootLayerId: LayerId
	readonly actorId: string
	private revision = 0
	private writerId = ''
	private readonly layers = new Map<LayerId, SemanticLayerDefinition>()
	private readonly listeners = new Set<LayerModelListener>()

	constructor(
		snapshot: Pick<SerializedLayerModel, 'rootLayerId' | 'layers'> & Partial<Pick<SerializedLayerModel, 'revision' | 'writerId'>> = { rootLayerId: 'root', layers: [] },
		options: { actorId?: string } = {},
	) {
		this.rootLayerId = snapshot.rootLayerId
		this.actorId = options.actorId ?? globalThis.crypto?.randomUUID?.() ?? `layer-model-${Date.now()}-${Math.random()}`
		this.replace(snapshot.layers, false)
		this.revision = snapshot.revision ?? 0
		this.writerId = snapshot.writerId ?? ''
	}

	get(id: LayerId): SemanticLayerDefinition | undefined {
		const layer = this.layers.get(id)
		return layer ? cloneDefinition(layer) : undefined
	}

	values(): SemanticLayerDefinition[] {
		return [...this.layers.values()].map(cloneDefinition)
	}

	defineOrUpdate(input: {
		id: LayerId
		parent?: LayerId
		policy?: Partial<TrackPolicy>
		cameraPanUnit?: 'layer' | 'screen'
		layout?: LayerLayout
	}): SemanticLayerDefinition {
		if (input.id === this.rootLayerId) throw new Error('The root layer is implicit and cannot be redefined.')
		const previous = this.layers.get(input.id)
		const next: SemanticLayerDefinition = {
			id: input.id,
			parent: input.parent ?? previous?.parent ?? this.rootLayerId,
			policy: { ...DEFAULT_POLICY, ...previous?.policy, ...input.policy },
			cameraPanUnit: input.cameraPanUnit ?? previous?.cameraPanUnit ?? 'layer',
			layout: input.layout ? { ...input.layout } : previous?.layout ? { ...previous.layout } : undefined,
		}
		if (next.parent !== this.rootLayerId && !this.layers.has(next.parent)) {
			throw new Error(`Parent layer "${next.parent}" is not defined in the project layer model.`)
		}
		this.layers.set(next.id, next)
		try {
			this.assertAcyclic(next.id)
		} catch (error) {
			if (previous) this.layers.set(previous.id, previous)
			else this.layers.delete(next.id)
			throw error
		}
		if (previous && JSON.stringify(previous) === JSON.stringify(next)) return cloneDefinition(next)
		this.changed()
		return cloneDefinition(next)
	}

	remove(id: LayerId): void {
		if (!this.layers.has(id)) return
		for (const layer of this.layers.values()) {
			if (layer.parent === id) throw new Error(`Cannot remove layer "${id}" while it has children.`)
		}
		this.layers.delete(id)
		this.changed()
	}

	reconcile(snapshot: SerializedLayerModel): void {
		if (snapshot.version !== 1) throw new Error(`Unsupported layer model version "${snapshot.version}".`)
		if (snapshot.rootLayerId !== this.rootLayerId) throw new Error('Cannot reconcile layer models with different roots.')
		const incomingWriter = snapshot.writerId ?? ''
		if (snapshot.revision < this.revision) return
		if (snapshot.revision === this.revision && incomingWriter <= this.writerId) return
		const validated = new LayerModel({ rootLayerId: snapshot.rootLayerId, layers: snapshot.layers })
		if (JSON.stringify(this.values()) === JSON.stringify(validated.values())) {
			this.revision = snapshot.revision
			this.writerId = incomingWriter
			return
		}
		this.replace(validated.values(), false)
		this.revision = snapshot.revision
		this.writerId = incomingWriter
		const reconciled = this.serialize()
		for (const listener of this.listeners) listener(reconciled)
	}

	serialize(): SerializedLayerModel {
		return { version: 1, rootLayerId: this.rootLayerId, revision: this.revision, writerId: this.writerId, layers: this.values() }
	}

	subscribe(listener: LayerModelListener): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private replace(layers: readonly SemanticLayerDefinition[], notify: boolean) {
		this.layers.clear()
		for (const layer of layers) this.layers.set(layer.id, cloneDefinition(layer))
		for (const layer of this.layers.values()) {
			if (layer.parent !== this.rootLayerId && !this.layers.has(layer.parent)) {
				throw new Error(`Parent layer "${layer.parent}" is not defined in the project layer model.`)
			}
			this.assertAcyclic(layer.id)
		}
		if (notify) this.changed()
	}

	private changed() {
		this.revision += 1
		this.writerId = this.actorId
		const snapshot = this.serialize()
		for (const listener of this.listeners) listener(snapshot)
	}

	private assertAcyclic(id: LayerId) {
		const seen = new Set<LayerId>()
		let current = this.layers.get(id)
		while (current) {
			if (seen.has(current.id)) throw new Error(`Layer "${id}" creates a cycle.`)
			seen.add(current.id)
			current = current.parent === this.rootLayerId ? undefined : this.layers.get(current.parent)
		}
	}
}

export function createLayerModel(
	snapshot?: Pick<SerializedLayerModel, 'rootLayerId' | 'layers'> & Partial<Pick<SerializedLayerModel, 'revision' | 'writerId'>>,
	options?: { actorId?: string },
): LayerModel {
	return new LayerModel(snapshot, options)
}
