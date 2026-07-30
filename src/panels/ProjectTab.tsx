import { useCallback, useContext, useSyncExternalStore } from 'react'
import { useEditor, useValue, type Editor, type TLCamera } from 'tldraw'
import { ProjectContext } from '../PanelContext'
import {
  SPATIAL_MAP_ZOOM,
  focusSpatialDocument,
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

const savedMapCameras = new WeakMap<Editor, TLCamera>()

export function ProjectTab({ query = '' }: { query?: string }) {
  const editor = useEditor()
  const project = useContext(ProjectContext)
  const nodes = useValue(
    'project-tab-spatial-documents',
    () => spatialWorldDocuments(editor, project?.projectName),
    [editor, project?.projectName],
  )
  const zoom = useValue('project-tab-zoom', () => editor.getZoomLevel(), [editor])
  const ui = useSyncExternalStore(subscribeSpatialWorldUi, getSpatialWorldUi)
  const normalizedQuery = query.trim().toLowerCase()
  const visibleNodes = nodes.filter(node =>
    !normalizedQuery || node.title.toLowerCase().includes(normalizedQuery)
  )

  const toggleMap = useCallback(() => {
    const savedCamera = savedMapCameras.get(editor)
    if (zoom <= SPATIAL_MAP_ZOOM && savedCamera) {
      editor.setCamera(savedCamera, { animation: { duration: 300 } })
      savedMapCameras.delete(editor)
      return
    }
    const bounds = spatialWorldBounds(nodes)
    if (!bounds) return
    savedMapCameras.set(editor, editor.getCamera())
    zoomToSpatialWorld(editor, bounds)
  }, [editor, nodes, zoom])

  const activate = useCallback((nodeId: string) => {
    const node = nodes.find(candidate => candidate.id === nodeId)
    if (!node) return
    selectSpatialWorldNode(node.id)
    savedMapCameras.delete(editor)
    focusSpatialDocument(editor, node)
  }, [editor, nodes])

  return (
    <div className="doc-panel-content project-tab">
      <div className="project-tab-toolbar">
        <button
          type="button"
          className={`project-map-button${zoom <= SPATIAL_MAP_ZOOM ? ' active' : ''}`}
          onClick={toggleMap}
          disabled={nodes.length === 0}
        >
          {zoom <= SPATIAL_MAP_ZOOM && savedMapCameras.has(editor) ? 'Return' : 'Map'}
        </button>
      </div>
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
