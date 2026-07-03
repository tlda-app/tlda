export const TLDA_MANAGED_SURFACE_KINDS = [
	'temporary-markdown',
	'annotation-viewer',
	'page-column',
	'page-column-handle',
	'lightbox',
] as const

export type TldaManagedSurfaceKind = typeof TLDA_MANAGED_SURFACE_KINDS[number]
