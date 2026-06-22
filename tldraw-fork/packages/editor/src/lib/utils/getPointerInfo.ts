import type React from 'react'
import { Editor } from '../editor/Editor'
import { TLViewportId } from '../editor/viewports/TLViewport'
import { isAccelKey } from './keyboard'
import { getPointerEventButton } from './pointer'

/** @public */
export function getPointerInfo(
	editor: Editor,
	e: React.PointerEvent | PointerEvent,
	opts?: { viewportId?: TLViewportId }
) {
	editor.markEventAsHandled(e)

	return {
		viewportId: opts?.viewportId,
		point: {
			x: e.clientX,
			y: e.clientY,
			z: e.pressure,
		},
		shiftKey: e.shiftKey,
		altKey: e.altKey,
		ctrlKey: e.metaKey || e.ctrlKey,
		metaKey: e.metaKey,
		accelKey: isAccelKey(e),
		pointerId: e.pointerId,
		button: getPointerEventButton(e),
		isPen: e.pointerType === 'pen',
	}
}
