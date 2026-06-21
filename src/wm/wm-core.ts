export type LayerId = string

export interface Camera {
	x: number
	y: number
	z: number
}

export interface LayerLayout {
	axis: 'vertical' | 'horizontal'
	spacing: number
}

export type AxisTrackPolicy = 'pan' | 'pin' | { track: number }
export type ZoomTrackPolicy = 'inherit' | 'lock' | 'own'

export interface TrackPolicy {
	x: AxisTrackPolicy
	y: AxisTrackPolicy
	zoom: ZoomTrackPolicy
}

export interface LayerDefinition {
	parent?: LayerId
	policy?: Partial<TrackPolicy>
	camera?: Partial<Camera>
	layout?: LayerLayout
}

export interface Layer {
	id: LayerId
	parent?: LayerId
	policy: TrackPolicy
	camera: Camera
	layout?: LayerLayout
}

export interface WMCoreOptions {
	rootLayerId?: LayerId
}

const DEFAULT_POLICY: TrackPolicy = {
	x: 'pan',
	y: 'pan',
	zoom: 'inherit',
}

const DEFAULT_CAMERA: Camera = {
	x: 0,
	y: 0,
	z: 1,
}

function normalizePolicy(policy?: Partial<TrackPolicy>): TrackPolicy {
	return {
		x: policy?.x ?? DEFAULT_POLICY.x,
		y: policy?.y ?? DEFAULT_POLICY.y,
		zoom: policy?.zoom ?? DEFAULT_POLICY.zoom,
	}
}

function normalizeCamera(camera?: Partial<Camera>): Camera {
	return {
		x: camera?.x ?? DEFAULT_CAMERA.x,
		y: camera?.y ?? DEFAULT_CAMERA.y,
		z: camera?.z ?? DEFAULT_CAMERA.z,
	}
}

function cloneCamera(camera: Camera): Camera {
	return { x: camera.x, y: camera.y, z: camera.z }
}

function cloneLayer(layer: Layer): Layer {
	return {
		id: layer.id,
		parent: layer.parent,
		policy: { ...layer.policy },
		camera: { ...layer.camera },
		layout: layer.layout ? { ...layer.layout } : undefined,
	}
}

export class WMCore {
	readonly rootLayerId: LayerId
	private readonly layers = new Map<LayerId, Layer>()

	constructor(options: WMCoreOptions = {}) {
		this.rootLayerId = options.rootLayerId ?? 'root'
		this.layers.set(this.rootLayerId, {
			id: this.rootLayerId,
			policy: normalizePolicy({ x: 'pin', y: 'pin', zoom: 'lock' }),
			camera: normalizeCamera(),
		})
	}

	defineLayer(id: LayerId, definition: LayerDefinition = {}): Layer {
		if (this.layers.has(id)) throw new Error(`Layer "${id}" already exists.`)

		const parent = definition.parent ?? this.rootLayerId
		if (!this.layers.has(parent)) throw new Error(`Parent layer "${parent}" is not defined.`)
		if (parent === id) throw new Error('A layer cannot be its own parent.')

		const layer: Layer = {
			id,
			parent,
			policy: normalizePolicy(definition.policy),
			camera: normalizeCamera(definition.camera),
			layout: definition.layout ? { ...definition.layout } : undefined,
		}

		this.layers.set(id, layer)
		this.assertAcyclic(id)
		return cloneLayer(layer)
	}

	getLayer(id: LayerId): Layer {
		return cloneLayer(this.requireLayer(id))
	}

	camera(layerId: LayerId): Camera {
		return cloneCamera(this.requireLayer(layerId).camera)
	}

	setCamera(layerId: LayerId, camera: Camera): void {
		this.requireLayer(layerId).camera = cloneCamera(camera)
	}

	configureLayout(layerId: LayerId, layout: LayerLayout): void {
		this.requireLayer(layerId).layout = { ...layout }
	}

	private requireLayer(id: LayerId): Layer {
		const layer = this.layers.get(id)
		if (!layer) throw new Error(`Layer "${id}" is not defined.`)
		return layer
	}

	private assertAcyclic(id: LayerId): void {
		const seen = new Set<LayerId>()
		let current: Layer | undefined = this.requireLayer(id)
		while (current?.parent) {
			if (seen.has(current.id)) throw new Error(`Layer "${id}" creates a cycle.`)
			seen.add(current.id)
			current = this.layers.get(current.parent)
		}
	}
}

export function createWMCore(options?: WMCoreOptions): WMCore {
	return new WMCore(options)
}
