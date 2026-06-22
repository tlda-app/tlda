import { useQuickReactor, useValue } from '@tldraw/state-react'
import type { TLShape } from '@tldraw/tlschema'
import { objectMapValues } from '@tldraw/utils'
import classNames from 'classnames'
import {
	Fragment,
	JSX,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
	type PointerEvent,
	type WheelEvent,
} from 'react'
import { TLViewport, TLViewportId } from '../editor/viewports/TLViewport'
import { useEditorComponents } from '../hooks/EditorComponentsContext'
import { useCanvasEvents } from '../hooks/useCanvasEvents'
import { useEditor } from '../hooks/useEditor'
import { ShapeCullingProvider, useShapeCulling } from '../hooks/useShapeCulling'
import { Box } from '../primitives/Box'
import { toDomPrecision } from '../primitives/utils'
import { VecLike } from '../primitives/Vec'
import { debugFlags } from '../utils/debug-flags'
import { setStyleProperty } from '../utils/dom'
import { normalizeWheel } from '../utils/normalizeWheel'
import { Shape } from './Shape'
import { CanvasOverlays } from './default-components/CanvasOverlays'

/** @public */
export interface TldrawViewportProps {
	id: TLViewportId
	camera: TLViewport['camera']
	pageId?: TLViewport['pageId']
	className?: string
	shapePredicate?(shape: TLShape): boolean
	onCameraChange?(camera: TLViewport['camera']): void
}

/** @public @react */
export function TldrawViewport({
	id,
	camera,
	pageId,
	className,
	shapePredicate,
	onCameraChange,
}: TldrawViewportProps) {
	const editor = useEditor()
	const { Background, Grid, SvgDefs } = useEditorComponents()
	const rCanvas = useRef<HTMLDivElement>(null)
	const rHtmlLayer = useRef<HTMLDivElement>(null)
	const rTouchPan = useRef<null | {
		pointerId: number
		x: number
		y: number
		camera: TLViewport['camera']
	}>(null)
	const [screenBounds, setScreenBounds] = useState<Box | null>(null)
	const events = useCanvasEvents({ viewportId: id })

	useLayoutEffect(() => {
		const canvas = rCanvas.current
		if (!canvas) return

		const updateBounds = () => {
			const rect = canvas.getBoundingClientRect()
			setScreenBounds(
				new Box(rect.left || rect.x, rect.top || rect.y, rect.width || 1, rect.height || 1)
			)
		}

		updateBounds()
		const resizeObserver = new ResizeObserver(updateBounds)
		resizeObserver.observe(canvas)
		window.addEventListener('resize', updateBounds)
		return () => {
			resizeObserver.disconnect()
			window.removeEventListener('resize', updateBounds)
		}
	}, [])

	useLayoutEffect(() => {
		if (!screenBounds) return
		return editor.registerViewport({
			id,
			pageId: pageId ?? editor.getCurrentPageId(),
			screenBounds: screenBounds.toJson(),
			camera,
		})
	}, [camera, editor, id, pageId, screenBounds])

	useQuickReactor(
		'position viewport layers',
		() => {
			const { x, y, z } = camera
			setStyleProperty(
				rHtmlLayer.current,
				'transform',
				`scale(${toDomPrecision(z)}) translate(${toDomPrecision(x)}px,${toDomPrecision(y)}px)`
			)
		},
		[camera]
	)

	const onWheel = useCallback(
		(event: WheelEvent) => {
			if (!onCameraChange) return
			event.preventDefault()
			event.stopPropagation()

			const delta = normalizeWheel(event.nativeEvent)
			if (!event.ctrlKey && !event.metaKey) {
				onCameraChange({
					x: camera.x - delta.x / camera.z,
					y: camera.y - delta.y / camera.z,
					z: camera.z,
				})
				return
			}

			const rect = event.currentTarget.getBoundingClientRect()
			const screenPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top }
			const pagePoint = screenToPage(screenPoint, camera)
			const nextZ = Math.max(0.05, Math.min(8, camera.z * Math.exp(-delta.y / 500)))
			onCameraChange({
				x: screenPoint.x / nextZ - pagePoint.x,
				y: screenPoint.y / nextZ - pagePoint.y,
				z: nextZ,
			})
		},
		[camera, onCameraChange]
	)

	const shouldPanWithTouch = useCallback(
		(event: PointerEvent) => {
			if (!onCameraChange || event.pointerType !== 'touch' || !event.isPrimary) return false
			const toolId = editor.getCurrentToolId()
			return toolId === 'select' || toolId === 'hand'
		},
		[editor, onCameraChange]
	)

	const onPointerDown = useCallback(
		(event: PointerEvent<HTMLDivElement>) => {
			if (!shouldPanWithTouch(event)) {
				events.onPointerDown?.(event)
				return
			}

			event.preventDefault()
			event.stopPropagation()
			event.currentTarget.setPointerCapture(event.pointerId)
			rTouchPan.current = {
				pointerId: event.pointerId,
				x: event.clientX,
				y: event.clientY,
				camera,
			}
		},
		[camera, events, shouldPanWithTouch]
	)

	const onPointerMove = useCallback(
		(event: PointerEvent<HTMLDivElement>) => {
			const touchPan = rTouchPan.current
			if (!touchPan || touchPan.pointerId !== event.pointerId || !onCameraChange) return

			event.preventDefault()
			event.stopPropagation()
			onCameraChange({
				x: touchPan.camera.x + (event.clientX - touchPan.x) / touchPan.camera.z,
				y: touchPan.camera.y + (event.clientY - touchPan.y) / touchPan.camera.z,
				z: touchPan.camera.z,
			})
		},
		[onCameraChange]
	)

	const onPointerUp = useCallback(
		(event: PointerEvent<HTMLDivElement>) => {
			const touchPan = rTouchPan.current
			if (!touchPan || touchPan.pointerId !== event.pointerId) {
				events.onPointerUp?.(event)
				return
			}

			event.preventDefault()
			event.stopPropagation()
			rTouchPan.current = null
			event.currentTarget.releasePointerCapture(event.pointerId)
		},
		[events]
	)

	const onPointerCancel = useCallback(
		(event: PointerEvent<HTMLDivElement>) => {
			if (rTouchPan.current?.pointerId === event.pointerId) {
				rTouchPan.current = null
			}
			events.onPointerCancel?.(event)
		},
		[events]
	)

	const shapeSvgDefs = useShapeSvgDefs()
	const isGridMode = useValue('viewport grid mode', () => editor.getInstanceState().isGridMode, [
		editor,
	])
	const gridSize = useValue('viewport grid size', () => editor.getDocumentSettings().gridSize, [
		editor,
	])

	return (
		<div
			ref={rCanvas}
			draggable={false}
			className={classNames('tl-canvas', 'tl-viewport', className)}
			data-testid="tldraw-viewport"
			onWheel={onWheel}
			{...events}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerCancel}
		>
			<svg className="tl-svg-context" aria-hidden="true">
				<defs>
					{shapeSvgDefs}
					{SvgDefs && <SvgDefs />}
				</defs>
			</svg>
			{Background && (
				<div className="tl-background__wrapper">
					<Background />
				</div>
			)}
			{isGridMode && Grid && <Grid x={camera.x} y={camera.y} z={camera.z} size={gridSize} />}
			<div ref={rHtmlLayer} className="tl-html-layer tl-shapes" draggable={false}>
				<ViewportSelectionBackground />
				<ViewportShapesLayer viewportId={id} shapePredicate={shapePredicate} />
			</div>
			{screenBounds ? (
				<CanvasOverlays viewportId={id} camera={camera} screenBounds={screenBounds.toJson()} />
			) : null}
		</div>
	)
}

function useShapeSvgDefs() {
	const editor = useEditor()
	return useValue(
		'viewport shapeSvgDefs',
		() => {
			const shapeSvgDefsByKey = new Map<string, JSX.Element>()
			for (const util of objectMapValues(editor.shapeUtils)) {
				if (!util) return
				const defs = util.getCanvasSvgDefs()
				for (const { key, component: Component } of defs) {
					if (shapeSvgDefsByKey.has(key)) continue
					shapeSvgDefsByKey.set(key, <Component key={key} />)
				}
			}
			return [...shapeSvgDefsByKey.values()]
		},
		[editor]
	)
}

function ViewportSelectionBackground() {
	const editor = useEditor()
	const selectionRotation = useValue('viewport selection rotation', () => editor.getSelectionRotation(), [
		editor,
	])
	const selectionBounds = useValue(
		'viewport selection bounds',
		() => editor.getSelectionRotatedPageBounds(),
		[editor]
	)
	const { SelectionBackground } = useEditorComponents()
	if (!selectionBounds || !SelectionBackground) return null
	return <SelectionBackground bounds={selectionBounds} rotation={selectionRotation} />
}

function ViewportShapesLayer({
	viewportId,
	shapePredicate,
}: {
	viewportId: TLViewportId
	shapePredicate?: (shape: TLShape) => boolean
}) {
	const editor = useEditor()
	const debugSvg = useValue('viewport debug svg', () => debugFlags.debugSvg.get(), [debugFlags])
	const renderingShapes = useValue(
		'viewport rendering shapes',
		() => {
			const shapes = editor.getRenderingShapes({ viewportId })
			if (!shapePredicate) return shapes
			return shapes.filter((result) => shapePredicate(result.shape))
		},
		[editor, shapePredicate, viewportId]
	)

	return (
		<ShapeCullingProvider>
			{renderingShapes.map((result) =>
				debugSvg ? (
					<Fragment key={result.id + '_fragment'}>
						<Shape {...result} initialIsCulled={false} />
					</Fragment>
				) : (
					<Shape key={result.id + '_shape'} {...result} initialIsCulled={false} />
				)
			)}
			<ViewportCullingController viewportId={viewportId} />
		</ShapeCullingProvider>
	)
}

function ViewportCullingController({ viewportId }: { viewportId: TLViewportId }) {
	const editor = useEditor()
	const { updateCulling } = useShapeCulling()

	useQuickReactor(
		'update viewport shape culling',
		() => {
			updateCulling(editor.getCulledShapes({ viewportId }))
		},
		[editor, updateCulling, viewportId]
	)

	return null
}

function screenToPage(point: VecLike, camera: TLViewport['camera']) {
	return {
		x: point.x / camera.z - camera.x,
		y: point.y / camera.z - camera.y,
	}
}
