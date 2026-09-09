import { useEffect, useMemo, useState } from 'react'
import { useValue, type Editor, type TLShape } from 'tldraw'
import { CanvasClipPanel, type ClipBounds } from '../CanvasClipPanel'
import { useFleetIdentity } from '../fleet-data-adapter'
import { getDeviceId, isDeviceReady, whenDeviceReady } from '../fleet/fleet-data.mjs'
import { classroomDocViewPlaybackSelection } from './classroom-doc-view-playback-selection'
import './ClassroomDocViewPlayback.css'

function selectionBounds(editor: Editor, shapes: readonly TLShape[]): ClipBounds | null {
  const bounds = shapes.map(shape => editor.getShapePageBounds(shape.id)).filter(Boolean) as ClipBounds[]
  if (bounds.length === 0) return null
  const x = Math.min(...bounds.map(bound => bound.x))
  const y = Math.min(...bounds.map(bound => bound.y))
  const right = Math.max(...bounds.map(bound => bound.x + bound.w))
  const bottom = Math.max(...bounds.map(bound => bound.y + bound.h))
  return { x, y, w: right - x, h: bottom - y }
}

/** Classroom's playback surface: the ordinary doc-view shapes only. */
export function ClassroomDocViewPlayback({ mainEditor }: { mainEditor: Editor }) {
  const { id: userId } = useFleetIdentity()
  const [deviceReady, setDeviceReady] = useState(isDeviceReady())
  useEffect(() => {
    let cancelled = false
    whenDeviceReady().then(() => { if (!cancelled) setDeviceReady(true) })
    return () => { cancelled = true }
  }, [])
  const deviceId = deviceReady ? getDeviceId() : ''
  const shapes = useValue('classroom-doc-view-playback', () => (
    classroomDocViewPlaybackSelection(mainEditor.getCurrentPageShapes(), { userId: userId ?? '', deviceId }, deviceReady)
  ), [mainEditor, userId, deviceId, deviceReady])
  const bounds = useValue('classroom-doc-view-playback-bounds', () => selectionBounds(mainEditor, shapes), [mainEditor, shapes])
  const ids = useMemo(() => new Set(shapes.map(shape => shape.id)), [shapes])

  if (!bounds) return null
  return (
    <div className="classroom-docview-playback">
      <CanvasClipPanel
        mainEditor={mainEditor}
        bounds={bounds}
        panelWidth={bounds.w}
        maxHeightFraction={1}
        lockCamera={true}
        liveEdit={true}
        disableCulling={true}
        shapePredicate={shape => ids.has(shape.id)}
        className="classroom-docview-playback__canvas"
      />
    </div>
  )
}
