export type LayerId = string

export interface Point {
	x: number
	y: number
	z?: number
}

export interface Bounds {
	x: number
	y: number
	w: number
	h: number
}

export interface Camera {
	x: number
	y: number
	z: number
}

export interface LayerTransform {
	x: number
	y: number
	scale: number
}

export type AxisTrackPolicy = 'pan' | 'pin' | { track: number }
export type ZoomTrackPolicy = 'inherit' | 'lock' | 'own'

export interface TrackPolicy {
	x: AxisTrackPolicy
	y: AxisTrackPolicy
	zoom: ZoomTrackPolicy
}

export interface LayerLayout {
	axis: 'vertical' | 'horizontal'
	spacing: number
}

export interface ForkViewportAdapter {
	screenToPage(point: Point, opts: { viewportId: string }): Point
	pageToScreen(point: Point, opts: { viewportId: string }): Point
	getCamera?(viewportId: string): Camera
	setCamera?(viewportId: string, camera: Camera): void
}

export interface PageCoordinateAdapter {
	screenToPage(point: Point): Point
	pageToScreen(point: Point): Point
}

export type LayerBacking =
	| { kind: 'frame' }
	| { kind: 'screen' }
	| { kind: 'page'; editor: PageCoordinateAdapter }
	| { kind: 'viewport'; viewportId: string; editor: ForkViewportAdapter }

export interface LayerDefinition {
	parent?: LayerId
	policy?: Partial<TrackPolicy>
	transform?: Partial<LayerTransform>
	camera?: Partial<Camera>
	backing?: LayerBacking
	layout?: LayerLayout
}

export interface Layer {
	id: LayerId
	parent?: LayerId
	policy: TrackPolicy
	transform: LayerTransform
	camera: Camera
	backing: LayerBacking
	layout?: LayerLayout
}

export interface LayeredShape {
	id: string
	x: number
	y: number
	layerId: LayerId
}

export interface LayerOwner {
	userId: string
	deviceId: string
}

export interface LayerMembership extends LayerOwner {
	layerId: LayerId
}

export interface WMCoreOptions {
	rootLayerId?: LayerId
}

const DEFAULT_POLICY: TrackPolicy = {
	x: 'pan',
	y: 'pan',
	zoom: 'inherit',
}

const DEFAULT_TRANSFORM: LayerTransform = {
	x: 0,
	y: 0,
	scale: 1,
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

function normalizeTransform(transform?: Partial<LayerTransform>): LayerTransform {
	return {
		x: transform?.x ?? DEFAULT_TRANSFORM.x,
		y: transform?.y ?? DEFAULT_TRANSFORM.y,
		scale: transform?.scale ?? DEFAULT_TRANSFORM.scale,
	}
}

function normalizeCamera(camera?: Partial<Camera>): Camera {
	return {
		x: camera?.x ?? DEFAULT_CAMERA.x,
		y: camera?.y ?? DEFAULT_CAMERA.y,
		z: camera?.z ?? DEFAULT_CAMERA.z,
	}
}

function axisTrackFactor(policy: AxisTrackPolicy) {
	if (policy === 'pan') return 1
	if (policy === 'pin') return 0
	return policy.track
}

function zoomFactor(policy: ZoomTrackPolicy, camera: Camera) {
	if (policy === 'lock') return 1
	return camera.z
}

function clonePoint(point: Point): Point {
	return { x: point.x, y: point.y, ...(point.z === undefined ? {} : { z: point.z }) }
}

function cloneCamera(camera: Camera): Camera {
	return { x: camera.x, y: camera.y, z: camera.z }
}

function cloneLayer(layer: Layer): Layer {
	return {
		id: layer.id,
		parent: layer.parent,
		policy: { ...layer.policy },
		transform: { ...layer.transform },
		camera: { ...layer.camera },
		backing: layer.backing,
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
			transform: normalizeTransform(),
			camera: normalizeCamera(),
			backing: { kind: 'screen' },
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
			transform: normalizeTransform(definition.transform),
			camera: normalizeCamera(definition.camera),
			backing: definition.backing ?? { kind: 'frame' },
			layout: definition.layout ? { ...definition.layout } : undefined,
		}

		this.layers.set(id, layer)
		this.assertAcyclic(id)
		return cloneLayer(layer)
	}

	getLayer(id: LayerId): Layer {
		return cloneLayer(this.requireLayer(id))
	}

	layerOf(shape: { layerId?: LayerId }): Layer {
		return this.getLayer(shape.layerId ?? this.rootLayerId)
	}

	removeLayer(id: LayerId): void {
		if (id === this.rootLayerId) throw new Error('Cannot remove the root layer.')
		this.requireLayer(id)
		for (const layer of this.layers.values()) {
			if (layer.parent === id) throw new Error(`Cannot remove layer "${id}" while it has children.`)
		}
		this.layers.delete(id)
	}

	translate(point: Point, fromLayer: LayerId, toLayer: LayerId): Point {
		this.requireLayer(fromLayer)
		this.requireLayer(toLayer)
		if (fromLayer === toLayer) return clonePoint(point)
		const rootPoint = this.layerToRoot(point, fromLayer)
		return this.rootToLayer(rootPoint, toLayer)
	}

	translateBounds(bounds: Bounds, fromLayer: LayerId, toLayer: LayerId): Bounds {
		const corners = [
			{ x: bounds.x, y: bounds.y },
			{ x: bounds.x + bounds.w, y: bounds.y },
			{ x: bounds.x, y: bounds.y + bounds.h },
			{ x: bounds.x + bounds.w, y: bounds.y + bounds.h },
		].map((point) => this.translate(point, fromLayer, toLayer))

		const xs = corners.map((point) => point.x)
		const ys = corners.map((point) => point.y)
		const minX = Math.min(...xs)
		const maxX = Math.max(...xs)
		const minY = Math.min(...ys)
		const maxY = Math.max(...ys)

		return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
	}

	camera(layerId: LayerId): Camera {
		const layer = this.requireLayer(layerId)
		if (layer.backing.kind === 'viewport') {
			return layer.backing.editor.getCamera?.(layer.backing.viewportId) ?? cloneCamera(layer.camera)
		}
		return cloneCamera(layer.camera)
	}

	setCamera(layerId: LayerId, camera: Camera): void {
		const layer = this.requireLayer(layerId)
		layer.camera = cloneCamera(camera)
		if (layer.backing.kind === 'viewport') {
			layer.backing.editor.setCamera?.(layer.backing.viewportId, cloneCamera(camera))
		}
	}

	configureLayout(layerId: LayerId, layout: LayerLayout): void {
		const layer = this.requireLayer(layerId)
		layer.layout = { ...layout }
	}

	moveToLayer<T extends LayeredShape>(shape: T, targetLayerId: LayerId): T {
		this.requireLayer(shape.layerId)
		this.requireLayer(targetLayerId)
		const point = this.translate({ x: shape.x, y: shape.y }, shape.layerId, targetLayerId)
		return { ...shape, x: point.x, y: point.y, layerId: targetLayerId }
	}

	pinToViewport<T extends LayeredShape>(shape: T, viewportLayerId: LayerId): T {
		return this.moveToLayer(shape, viewportLayerId)
	}

	unpin<T extends LayeredShape>(shape: T, targetLayerId = this.rootLayerId): T {
		return this.moveToLayer(shape, targetLayerId)
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

	private layerToRoot(point: Point, layerId: LayerId): Point {
		const layer = this.requireLayer(layerId)
		const parentPoint = this.layerToParent(point, layer)
		if (!layer.parent) return parentPoint
		return this.layerToRoot(parentPoint, layer.parent)
	}

	private rootToLayer(point: Point, layerId: LayerId): Point {
		const layer = this.requireLayer(layerId)
		if (!layer.parent) return clonePoint(point)
		const parentPoint = this.rootToLayer(point, layer.parent)
		return this.parentToLayer(parentPoint, layer)
	}

	private layerToParent(point: Point, layer: Layer): Point {
		if (layer.backing.kind === 'page') {
			return layer.backing.editor.pageToScreen(point)
		}
		if (layer.backing.kind === 'viewport') {
			return layer.backing.editor.pageToScreen(point, { viewportId: layer.backing.viewportId })
		}

		const transform = this.effectiveTransform(layer)
		return {
			x: point.x * transform.scale + transform.x,
			y: point.y * transform.scale + transform.y,
			...(point.z === undefined ? {} : { z: point.z }),
		}
	}

	private parentToLayer(point: Point, layer: Layer): Point {
		if (layer.backing.kind === 'page') {
			return layer.backing.editor.screenToPage(point)
		}
		if (layer.backing.kind === 'viewport') {
			return layer.backing.editor.screenToPage(point, { viewportId: layer.backing.viewportId })
		}

		const transform = this.effectiveTransform(layer)
		return {
			x: (point.x - transform.x) / transform.scale,
			y: (point.y - transform.y) / transform.scale,
			...(point.z === undefined ? {} : { z: point.z }),
		}
	}

	private effectiveTransform(layer: Layer): LayerTransform {
		const camera = this.camera(layer.id)
		return {
			x: layer.transform.x + camera.x * axisTrackFactor(layer.policy.x),
			y: layer.transform.y + camera.y * axisTrackFactor(layer.policy.y),
			scale: layer.transform.scale * zoomFactor(layer.policy.zoom, camera),
		}
	}
}

export function createWMCore(options?: WMCoreOptions): WMCore {
	return new WMCore(options)
}

export function createLayerOwner(userId = '', deviceId = ''): LayerOwner {
	return { userId, deviceId }
}

export function createLayerMembership(layerId: LayerId, owner: LayerOwner): LayerMembership {
	return { layerId, userId: owner.userId, deviceId: owner.deviceId }
}
