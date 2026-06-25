import { useEffect, useRef, useState } from 'react'
import { useEditor } from 'tldraw'
import type { Camera } from './wm-core'

export interface WMViewportSurfaceProps {
	viewportId: string
	camera: Camera
	onCameraChange: (camera: Camera) => void
	width?: number
	height?: number
	title?: string
	className?: string
	style?: React.CSSProperties
}

/**
 * WMViewportSurface — renders a second viewport into the main editor's canvas.
 *
 * Uses the tldraw fork's multi-viewport API:
 * - registerViewport() to create a named viewport
 * - updateViewport() to sync camera/screenBounds
 * - The main editor's renderer handles culling via getRenderingShapes({ viewportId })
 *
 * This component renders a transparent overlay that shows the viewport's bounds
 * and allows camera interaction. The actual shape rendering is done by the main
 * editor's <Tldraw> component, which respects the viewport's camera for culling.
 */
export function WMViewportSurface({
	viewportId,
	camera,
	onCameraChange,
	width = 400,
	height = 300,
	title,
	className,
	style,
}: WMViewportSurfaceProps) {
	const editor = useEditor()
	const containerRef = useRef<HTMLDivElement>(null)
	const [isDragging, setIsDragging] = useState(false)
	const dragStartRef = useRef<{ x: number; y: number; cameraX: number; cameraY: number } | null>(null)

	// Register viewport with main editor
	useEffect(() => {
		if (!containerRef.current) return

		const rect = containerRef.current.getBoundingClientRect()
		const unregister = editor.registerViewport({
			id: viewportId,
			screenBounds: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
			camera: { x: camera.x, y: camera.y, z: camera.z },
		})

		return unregister
	}, [editor, viewportId])

	// Update viewport when camera or size changes
	useEffect(() => {
		if (!containerRef.current) return

		const rect = containerRef.current.getBoundingClientRect()
		editor.updateViewport(viewportId, {
			screenBounds: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
			camera: { x: camera.x, y: camera.y, z: camera.z },
		})
	}, [editor, viewportId, camera, width, height])

	// Pointer handlers for camera panning
	const handlePointerDown = (e: React.PointerEvent) => {
		e.stopPropagation()
		setIsDragging(true)
		dragStartRef.current = {
			x: e.clientX,
			y: e.clientY,
			cameraX: camera.x,
			cameraY: camera.y,
		}
		;(e.target as HTMLElement).setPointerCapture(e.pointerId)
	}

	const handlePointerMove = (e: React.PointerEvent) => {
		if (!isDragging || !dragStartRef.current) return
		e.stopPropagation()

		const dx = (e.clientX - dragStartRef.current.x) / camera.z
		const dy = (e.clientY - dragStartRef.current.y) / camera.z

		onCameraChange({
			x: dragStartRef.current.cameraX - dx,
			y: dragStartRef.current.cameraY - dy,
			z: camera.z,
		})
	}

	const handlePointerUp = (e: React.PointerEvent) => {
		e.stopPropagation()
		setIsDragging(false)
		dragStartRef.current = null
	}

	const handleWheel = (e: React.WheelEvent) => {
		e.stopPropagation()
		const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1
		const newZoom = Math.max(0.1, Math.min(8, camera.z * zoomFactor))
		onCameraChange({ x: camera.x, y: camera.y, z: newZoom })
	}

	return (
		<div
			ref={containerRef}
			className={className}
			style={{
				width,
				height,
				position: 'relative',
				border: '2px solid rgba(100, 100, 255, 0.5)',
				borderRadius: 4,
				background: 'rgba(255, 255, 255, 0.05)',
				cursor: isDragging ? 'grabbing' : 'grab',
				...style,
			}}
			data-wm-viewport-id={viewportId}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerUp}
			onWheel={handleWheel}
		>
			{title && (
				<div
					style={{
						position: 'absolute',
						top: 0,
						left: 0,
						right: 0,
						padding: '4px 8px',
						background: 'rgba(100, 100, 255, 0.8)',
						color: 'white',
						fontSize: 11,
						fontWeight: 600,
						borderRadius: '2px 2px 0 0',
						pointerEvents: 'none',
					}}
				>
					{title}
				</div>
			)}
			<div
				style={{
					position: 'absolute',
					bottom: 4,
					right: 4,
					padding: '2px 6px',
					background: 'rgba(0, 0, 0, 0.6)',
					color: 'white',
					fontSize: 10,
					borderRadius: 2,
					pointerEvents: 'none',
				}}
			>
				{Math.round(camera.z * 100)}% | ({Math.round(camera.x)}, {Math.round(camera.y)})
			</div>
		</div>
	)
}
