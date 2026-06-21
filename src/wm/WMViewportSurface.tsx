import { useEffect, useMemo } from 'react'
import { TldrawViewport, useEditor, useValue } from 'tldraw'
import type { Editor, TLShape, TLViewportId } from 'tldraw'
import type { Camera } from './wm-core'

export interface WMViewportDiagnostics {
	viewportId: TLViewportId
	getCamera: () => Camera
	getViewport: () => unknown
	getRenderingShapeCount: () => number
	getCulledShapeCount: () => number
}

interface WMViewportSurfaceProps {
	viewportId: TLViewportId
	camera: Camera
	onCameraChange: (camera: Camera) => void
	title?: string
	className?: string
	style?: React.CSSProperties
	diagnosticsKey?: string
	shapePredicate?: (shape: TLShape) => boolean
}

type ShapeFilteredViewportProps = React.ComponentProps<typeof TldrawViewport> & {
	shapePredicate?: (shape: TLShape) => boolean
}

const ShapeFilteredTldrawViewport = TldrawViewport as React.ComponentType<ShapeFilteredViewportProps>

type DiagnosticsWindow = Window & Record<string, WMViewportDiagnostics | undefined>

function getRegisteredViewport(editor: Editor, viewportId: TLViewportId) {
	try {
		return editor.getViewport(viewportId)
	} catch {
		return null
	}
}

export function WMViewportSurface({
	viewportId,
	camera,
	onCameraChange,
	title,
	className,
	style,
	diagnosticsKey,
	shapePredicate,
}: WMViewportSurfaceProps) {
	const editor = useEditor()
	const renderingShapeCount = useValue(
		`wm viewport ${viewportId} rendering count`,
		() => editor.getRenderingShapes({ viewportId }).length,
		[editor, viewportId],
	)
	const culledShapeCount = useValue(
		`wm viewport ${viewportId} culled count`,
		() => editor.getCulledShapes({ viewportId }).size,
		[editor, viewportId],
	)
	const status = useMemo(
		() => `${renderingShapeCount} rendered / ${culledShapeCount} culled`,
		[renderingShapeCount, culledShapeCount],
	)

	useEffect(() => {
		if (!diagnosticsKey) return
		const target = window as unknown as DiagnosticsWindow
		target[diagnosticsKey] = {
			viewportId,
			getCamera: () => camera,
			getViewport: () => getRegisteredViewport(editor, viewportId),
				getRenderingShapeCount: () => editor.getRenderingShapes({ viewportId }).length,
				getCulledShapeCount: () => editor.getCulledShapes({ viewportId }).size,
		}
		return () => {
			if (target[diagnosticsKey]?.viewportId === viewportId) {
				delete target[diagnosticsKey]
			}
		}
	}, [camera, diagnosticsKey, editor, viewportId])

	return (
		<div
			className={className}
			style={style}
			data-wm-viewport-id={viewportId}
		>
			{title ? (
				<div
					style={{
						height: 26,
						display: 'flex',
						alignItems: 'center',
						gap: 8,
						padding: '0 8px',
						fontSize: 11,
						color: 'rgba(30,30,35,0.72)',
						borderBottom: '1px solid rgba(80,80,90,0.14)',
						flexShrink: 0,
					}}
				>
					<span style={{ fontWeight: 600 }}>{title}</span>
					<span style={{ flex: 1 }} />
					<span>{status}</span>
				</div>
			) : null}
			<div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
				<ShapeFilteredTldrawViewport
					id={viewportId}
					camera={camera}
					onCameraChange={onCameraChange}
					shapePredicate={shapePredicate}
				/>
			</div>
		</div>
	)
}
