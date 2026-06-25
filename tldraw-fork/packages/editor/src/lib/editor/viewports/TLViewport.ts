import { BoxModel, TLCamera, TLPageId } from '@tldraw/tlschema'
import { Box } from '../../primitives/Box'

/** @public */
export type TLViewportId = string

/** @public */
export const DEFAULT_VIEWPORT_ID: TLViewportId = 'default'

/** @public */
export interface TLViewport {
	id: TLViewportId
	pageId?: TLPageId
	screenBounds: BoxModel
	camera: Pick<TLCamera, 'x' | 'y' | 'z'>
}

/** @public */
export interface TLViewportOptions {
	viewportId?: TLViewportId
	viewport?: TLViewport
}

/** @public */
export function getViewportPageBounds(viewport: Pick<TLViewport, 'screenBounds' | 'camera'>) {
	const { w, h } = viewport.screenBounds
	const { x, y, z } = viewport.camera
	return new Box(-x, -y, w / z, h / z)
}
