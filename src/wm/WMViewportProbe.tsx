import { useState } from 'react'
import { useEditor } from 'tldraw'
import { WMViewportSurface } from './WMViewportSurface'
import {
	WM_PICTURE_IN_PICTURE_VIEWPORT_ID,
	createWMPictureInPictureLayer,
} from './viewport-layer'

function hasProbeFlag() {
	if (typeof window === 'undefined') return false
	return new URLSearchParams(window.location.search).get('wmViewportProbe') === '1'
}

export function WMViewportProbe() {
	if (!hasProbeFlag()) return null
	return <WMViewportProbePanel />
}

function WMViewportProbePanel() {
	const editor = useEditor()
	const [layer, setLayer] = useState(() => createWMPictureInPictureLayer({
		sourceCamera: editor.getCamera(),
	}))

	return (
		<WMViewportSurface
			className="wm-viewport-probe"
			viewportId={WM_PICTURE_IN_PICTURE_VIEWPORT_ID}
			camera={layer.camera}
			onCameraChange={(camera) => setLayer(current => ({ ...current, camera }))}
			title="picture-in-picture"
			diagnosticsKey="__tlda_wm_viewport_probe__"
			style={{
				position: 'absolute',
				right: 18,
				top: 58,
				width: 360,
				height: 260,
				zIndex: 200,
				background: 'rgba(250,250,250,0.96)',
				border: '1px solid rgba(80,80,90,0.22)',
				boxShadow: '0 8px 30px rgba(0,0,0,0.12)',
				display: 'flex',
				flexDirection: 'column',
				overflow: 'hidden',
			}}
		/>
	)
}
