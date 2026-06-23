import { useState } from 'react'
import { useEditor } from 'tldraw'
import { WMViewportSurface } from './WMViewportSurface'
import {
	WM_PICTURE_IN_PICTURE_VIEWPORT_ID,
	createWMPictureInPictureLayer,
} from './viewport-layer'

export function WMViewportProbe() {
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
			width={360}
			height={260}
			style={{
				position: 'absolute',
				right: 18,
				top: 58,
				zIndex: 200,
			}}
		/>
	)
}
