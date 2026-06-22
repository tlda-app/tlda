import { useEffect, useMemo } from 'react'
import { useEditor, useValue } from 'tldraw'
import type { TLShape } from 'tldraw'
import type { Camera } from './wm-core'
import { VisibilityViewportProvider } from '../shapes/useIsInViewport'
import type { VisibilityViewportId } from '../shapes/useIsInViewport'

export interface WMViewportDiagnostics {
	viewportId: VisibilityViewportId
	getCamera: () => Camera
	getViewport: () => unknown
	getRenderingShapeCount: () => number
	getCulledShapeCount: () => number
}

interface WMViewportSurfaceProps {
	viewportId: VisibilityViewportId
	camera: Camera
	onCameraChange: (camera: Camera) => void
	title?: string
	className?: string
	style?: React.CSSProperties
	diagnosticsKey?: string
	shapePredicate?: (shape: TLShape) => boolean
}

type DiagnosticsWindow = Window & Record<string, WMViewportDiagnostics | undefined>

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
	void onCameraChange
	void shapePredicate
	const renderingShapeCount = useValue(
		`wm viewport ${viewportId} rendering count`,
		() => editor.getRenderingShapes().length,
		[editor, viewportId],
	)
	const culledShapeCount = useValue(
		`wm viewport ${viewportId} culled count`,
		() => editor.getCulledShapes().size,
		[editor, viewportId],
	)
	const status = useMemo(
		() => `${renderingShapeCount} rendered / ${culledShapeCount} culled in main viewport`,
		[renderingShapeCount, culledShapeCount],
	)

	useEffect(() => {
		if (!diagnosticsKey) return
		const target = window as unknown as DiagnosticsWindow
		target[diagnosticsKey] = {
			viewportId,
			getCamera: () => camera,
			getViewport: () => null,
			getRenderingShapeCount: () => editor.getRenderingShapes().length,
			getCulledShapeCount: () => editor.getCulledShapes().size,
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
				<VisibilityViewportProvider viewportId={viewportId}>
					{import.meta.env.DEV ? (
						<div
							style={{
								position: 'absolute',
								inset: 0,
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								padding: 16,
								fontSize: 11,
								color: 'rgba(30,30,35,0.62)',
								pointerEvents: 'none',
							}}
						>
							WM viewport probe ({viewportId}) — {status}
						</div>
					) : null}
				</VisibilityViewportProvider>
			</div>
		</div>
	)
}
