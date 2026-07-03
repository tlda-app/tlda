export type WmExtractionClassification =
	| 'wm-package-core'
	| 'wm-package-tldraw-adapter'
	| 'tlda-host-adapter'
	| 'tlda-app-surface'

export interface WmExtractionModule {
	path: string
	classification: WmExtractionClassification
	publicContract: string
	remainingHostDependency?: string
}

export const WM_EXTRACTION_MODULES = [
	{
		path: 'src/wm/wm-core.ts',
		classification: 'wm-package-core',
		publicContract: 'Layer graph, camera policy, transforms, and coordinate conversion model.',
	},
	{
		path: 'src/wm/hosted-panel-registry.ts',
		classification: 'wm-package-core',
		publicContract: 'Hosted panel app definitions, default sizes, and default props.',
	},
	{
		path: 'src/wm/managed-surfaces.ts',
		classification: 'wm-package-core',
		publicContract: 'Managed surface request vocabulary, host-extensible kind strings, owner policy, placement, cleanup, persistence, and shape metadata.',
	},
	{
		path: 'src/wm/gesture-policy.ts',
		classification: 'wm-package-core',
		publicContract: 'Pure gesture thresholds, resize-axis policy, and host-supplied lane snap decisions.',
	},
	{
		path: 'src/wm/editor-wm.ts',
		classification: 'wm-package-tldraw-adapter',
		publicContract: 'TLDraw editor attachment, named viewport registration, and layer lookup.',
	},
	{
		path: 'src/wm/viewport-coordinates.ts',
		classification: 'wm-package-tldraw-adapter',
		publicContract: 'Frame-aware point conversion through registered TLDraw viewport layers.',
	},
	{
		path: 'src/wm/canvas-clip-panel.ts',
		classification: 'wm-package-tldraw-adapter',
		publicContract: 'Fork-facing named viewport capabilities, optional viewport lookup, surface camera sync, and host-injected shape predicates.',
	},
	{
		path: 'src/wm/gesture-frame.ts',
		classification: 'wm-package-tldraw-adapter',
		publicContract: 'DOM and TLDraw viewport frame helpers for gesture hit testing with host-supplied selectors.',
	},
	{
		path: 'src/wm/editor-host-bridge.ts',
		classification: 'tlda-host-adapter',
		publicContract: 'Current tlda host-editor globals and HUD reset/toggle event bridge.',
		remainingHostDependency: 'Replace fleet HUD event names and tlda globals with package host callbacks.',
	},
	{
		path: 'src/wm/fleet-hud-state.ts',
		classification: 'tlda-host-adapter',
		publicContract: 'Current fleet HUD expanded-state persistence contract.',
		remainingHostDependency: 'Rename and parameterize storage keys before package extraction.',
	},
	{
		path: 'src/shapes/fleet-panel-registry.ts',
		classification: 'tlda-host-adapter',
		publicContract: 'tlda fleet panel app registration against the generic hosted-panel registry.',
		remainingHostDependency: 'Keep concrete fleet panel types, titles, sizes, and app defaults in tlda.',
	},
	{
		path: 'src/shapes/fleet-layout-plan.ts',
		classification: 'tlda-host-adapter',
		publicContract: 'tlda default fleet layout shape plan using hosted panel definitions.',
		remainingHostDependency: 'Separate generic layout planner inputs from fleet-specific panel set and filters.',
	},
	{
		path: 'src/shapes/fleet-layout-geometry.ts',
		classification: 'tlda-host-adapter',
		publicContract: 'Current fleet lane offsets and disjointness repair.',
		remainingHostDependency: 'Remove document-page and fleet ownership predicates before package extraction.',
	},
	{
		path: 'src/shapes/fleet-ownership.ts',
		classification: 'tlda-host-adapter',
		publicContract: 'tlda fleet owner/device predicates and HUD anchor IDs.',
		remainingHostDependency: 'Host must supply identity/device predicates to the WM package.',
	},
	{
		path: 'src/wm/annotation-viewer-surface.ts',
		classification: 'tlda-app-surface',
		publicContract: 'Annotation viewer surface request adapter.',
		remainingHostDependency: 'Annotation labels, bullets, chip anchors, and bounds semantics stay in tlda.',
	},
	{
		path: 'src/wm/markdown-surface.ts',
		classification: 'tlda-app-surface',
		publicContract: 'Temporary markdown surface request adapter.',
		remainingHostDependency: 'Markdown document identity, chat provenance, and shared-path semantics stay in tlda.',
	},
	{
		path: 'src/wm/page-column-surface.ts',
		classification: 'tlda-app-surface',
		publicContract: 'Page-column and page-column-handle surface request adapters.',
		remainingHostDependency: 'Shadow column keys, source identifiers, and canvas-page payload semantics stay in tlda.',
	},
	{
		path: 'src/wm/lightbox-surface.ts',
		classification: 'tlda-app-surface',
		publicContract: 'Lightbox modal surface request adapter.',
		remainingHostDependency: 'Chat/media source keys and modal payload semantics stay in tlda.',
	},
] as const satisfies readonly WmExtractionModule[]

export const WM_PACKAGE_ENTRY_CANDIDATES = WM_EXTRACTION_MODULES
	.filter((module) => module.classification === 'wm-package-core' || module.classification === 'wm-package-tldraw-adapter')
	.map((module) => module.path)

export const TLDA_HOST_BOUNDARY_MODULES = WM_EXTRACTION_MODULES
	.filter((module) => module.classification === 'tlda-host-adapter' || module.classification === 'tlda-app-surface')
	.map((module) => module.path)

export function wmExtractionModulesByClassification(classification: WmExtractionClassification) {
	return WM_EXTRACTION_MODULES.filter((module) => module.classification === classification)
}
