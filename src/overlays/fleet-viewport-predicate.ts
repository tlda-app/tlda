import type { TLShape } from 'tldraw'

export function shouldRenderLockedFleetViewportShape(
	shape: TLShape | { type?: string; props?: unknown; meta?: unknown },
	owner?: { userId?: string | null; deviceId?: string | null },
): boolean {
	const type = shape.type
	if (!type?.startsWith('fleet-')) return false

	// Transient drag previews do not carry ownership props. They still need to
	// render inside the locked HUD viewport that owns the active drag gesture.
	if (type === 'fleet-pill') return true

	const props = shape.props as { userId?: unknown; deviceId?: unknown } | undefined
	if (!props?.userId || !props?.deviceId) return false
	if (!owner?.userId || !owner?.deviceId) return false
	return props.userId === owner.userId && props.deviceId === owner.deviceId
}
