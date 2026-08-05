import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useEditor, useValue, type Editor, type TLCamera } from 'tldraw'
import { CanvasClipPanel } from '../CanvasClipPanel'
import { ProjectContext } from '../PanelContext'
import {
  SPATIAL_MAP_ZOOM,
  activateSpatialDocument,
  currentSpatialDocument,
  spatialWorldBounds,
  spatialWorldDocuments,
  zoomToSpatialWorld,
} from '../spatialDocumentWorld'
import {
  getSpatialWorldUi,
  hoverSpatialWorldNode,
  selectSpatialWorldNode,
  subscribeSpatialWorldUi,
} from '../spatialDocumentWorldUi'
import { suppressFleetHudCameraTracking } from '../wm/fleet-hud-state'

/** Where you were when you zoomed out to the map: the camera to come back to,
 *  and the document your layout is currently wrapped around. Activating from
 *  the map wraps that layout around the document you pick, so the source is the
 *  document you left, not whatever the world-view camera happens to sit over. */
const savedMapCameras = new WeakMap<Editor, { camera: TLCamera; sourceNodeId: string | null }>()

export function ProjectTab({ query = '' }: { query?: string }) {
  const editor = useEditor()
  const project = useContext(ProjectContext)
  const nodes = useValue(
    'project-tab-spatial-documents',
    () => spatialWorldDocuments(editor, project?.projectName, project?.title),
    [editor, project?.projectName, project?.title],
  )
  const zoom = useValue('project-tab-zoom', () => editor.getZoomLevel(), [editor])
  const ui = useSyncExternalStore(subscribeSpatialWorldUi, getSpatialWorldUi)
  const normalizedQuery = query.trim().toLowerCase()
  const visibleNodes = nodes.filter(node =>
    !normalizedQuery || node.title.toLowerCase().includes(normalizedQuery)
  )

  const toggleMap = useCallback(() => {
    const saved = savedMapCameras.get(editor)
    if (zoom <= SPATIAL_MAP_ZOOM && saved) {
      editor.setCamera(saved.camera, { animation: { duration: 300 } })
      savedMapCameras.delete(editor)
      return
    }
    const bounds = spatialWorldBounds(nodes)
    if (!bounds) return
    savedMapCameras.set(editor, {
      camera: editor.getCamera(),
      sourceNodeId: currentSpatialDocument(editor, nodes)?.id ?? null,
    })
    zoomToSpatialWorld(editor, bounds, nodes.find(node => node.documentRef.kind === 'primary'))
  }, [editor, nodes, zoom])

  const activate = useCallback((nodeId: string) => {
    const node = nodes.find(candidate => candidate.id === nodeId)
    if (!node) return
    const saved = savedMapCameras.get(editor)
    const source = (saved?.sourceNodeId && nodes.find(candidate => candidate.id === saved.sourceNodeId))
      || currentSpatialDocument(editor, nodes)
    if (!source) return
    selectSpatialWorldNode(node.id)
    savedMapCameras.delete(editor)
    suppressFleetHudCameraTracking()
    activateSpatialDocument(editor, source, node, saved?.camera ?? editor.getCamera())
  }, [editor, nodes])

  return (
    <div className="doc-panel-content project-tab">
      <ProjectMapViewport
        editor={editor}
        bounds={spatialWorldBounds(nodes)}
        returning={zoom <= SPATIAL_MAP_ZOOM && savedMapCameras.has(editor)}
        onNavigate={toggleMap}
      />
      {visibleNodes.length === 0 && <div className="panel-empty">No documents found</div>}
      {visibleNodes.map(node => {
        const active = ui.hoveredNodeId === node.id || ui.selectedNodeId === node.id
        return (
          <button
            type="button"
            key={node.id}
            className={`project-document-row${active ? ' active' : ''}`}
            onPointerEnter={() => hoverSpatialWorldNode(node.id)}
            onPointerLeave={() => hoverSpatialWorldNode(null)}
            onFocus={() => hoverSpatialWorldNode(node.id)}
            onBlur={() => hoverSpatialWorldNode(null)}
            onClick={() => activate(node.id)}
          >
            {node.title}
          </button>
        )
      })}
    </div>
  )
}

function ProjectMapViewport({
  editor,
  bounds,
  returning,
  onNavigate,
}: {
  editor: Editor
  bounds: { x: number; y: number; w: number; h: number } | null
  returning: boolean
  onNavigate: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = () => setWidth(Math.max(1, Math.floor(host.getBoundingClientRect().width)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  if (!bounds) return null
  return (
    <div ref={hostRef} className="project-map-viewport">
      {width > 0 && (
        <CanvasClipPanel
          mainEditor={editor}
          bounds={bounds}
          panelWidth={width}
          maxHeightFraction={0.22}
          className="project-map-viewport-clip"
          readOnly
          interactionMode="preview"
          unboundedPanning
        />
      )}
      <button
        type="button"
        className="project-map-navigate"
        aria-label={returning ? 'Return to document view' : 'Open project map'}
        title={returning ? 'Return to document view' : 'Open project map'}
        onClick={onNavigate}
      >
        <svg width="72" height="72" viewBox="0 0 250 250" aria-hidden="true">
          <path
            d={returning ? 'M238 125 H12 M80 12 L12 125 L80 238' : 'M12 125 H238 M170 12 L238 125 L170 238'}
            fill="none"
            stroke="currentColor"
            strokeWidth="48"
            strokeLinecap="square"
            strokeLinejoin="miter"
          />
        </svg>
      </button>
    </div>
  )
}
