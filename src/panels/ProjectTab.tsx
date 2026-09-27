import { useCallback, useContext, useEffect, useState } from 'react'
import { useEditor, useValue } from 'tldraw'
import { ProjectContext } from '../PanelContext'
import { recordPlaceDeparture } from '../placeStack'
import {
  SPATIAL_MAP_ZOOM,
  clearSavedSpatialMapView,
  currentSpatialDocument,
  getSavedSpatialMapView,
  openSpatialDocument,
  saveSpatialMapView,
  spatialWorldBounds,
  spatialWorldDocuments,
  spatialMapActivationSource,
  zoomToSpatialWorld,
} from '../spatialDocumentWorld'
import { selectSpatialWorldNode } from '../spatialDocumentWorldUi'
import { suppressFleetHudCameraTracking } from '../wm/fleet-hud-state'
import { readingPositionStore } from '../readingPositionStore'

type ProjectDocument = { sourceFile: string; outputFile: string; title: string; format: string }
export function ProjectTab({ query = '' }: { query?: string }) {
  const editor = useEditor()
  const project = useContext(ProjectContext)
  const nodes = useValue(
    'project-tab-spatial-documents',
    () => spatialWorldDocuments(editor, project?.projectName, project?.title),
    [editor, project?.projectName, project?.title],
  )
  const zoom = useValue('project-tab-zoom', () => editor.getZoomLevel(), [editor])
  const [projectDocuments, setProjectDocuments] = useState<ProjectDocument[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  useEffect(() => {
    if (!project?.projectName) return
    let active = true
    fetch(`/api/projects/${encodeURIComponent(project.projectName)}/files`)
      .then(response => response.ok ? response.json() : null)
      .then(payload => {
        if (active) setProjectDocuments(Array.isArray(payload?.documents) ? payload.documents : [])
      })
      .catch(() => { if (active) setProjectDocuments([]) })
    return () => { active = false }
  }, [project?.projectName])
  const normalizedQuery = query.trim().toLowerCase()
  // Every row IS an existing map node and opens by node id: selecting a
  // document must never rewrite its shape URL or title, which is what the
  // unplaced-document path does (and must keep doing only for genuinely
  // unplaced documents). The payload only orders rows in server order and
  // never supplies titles — the placed display title is what the user reads,
  // and payload stems would replace it with a basename.
  const payloadOrder = new Map<string, number>()
  for (const [index, document] of projectDocuments.entries()) {
    payloadOrder.set(document.outputFile, index)
    const unprefixed = document.outputFile.replace(/^_book\//, '')
    payloadOrder.set(unprefixed, index)
    payloadOrder.set(`_book/${unprefixed}`, index)
  }
  const orderOf = (path?: string) => {
    if (!path) return Number.MAX_SAFE_INTEGER
    const unprefixed = path.replace(/^_book\//, '')
    return payloadOrder.get(path) ?? payloadOrder.get(unprefixed) ?? payloadOrder.get(`_book/${unprefixed}`) ?? Number.MAX_SAFE_INTEGER
  }
  type ProjectRow = { key: string; title: string; nodeId: string }
  const mapRows: ProjectRow[] = []
  for (const node of nodes) {
    if (node.documentRef.kind !== 'primary' && node.documentRef.kind !== 'materialized' && node.documentRef.kind !== 'shared') continue
    if (node.documentRef.kind !== 'primary' && !node.documentRef.path) continue
    mapRows.push({ key: node.id, title: node.title, nodeId: node.id })
  }
  const visibleProjectRows = mapRows
    .filter(row => !normalizedQuery || row.title.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => {
      const aNode = nodes.find(n => n.id === a.nodeId)
      const bNode = nodes.find(n => n.id === b.nodeId)
      const aPrimary = aNode?.documentRef.kind === 'primary'
      const bPrimary = bNode?.documentRef.kind === 'primary'
      if (aPrimary !== bPrimary) return aPrimary ? -1 : 1
      return orderOf(aNode?.documentRef.path) - orderOf(bNode?.documentRef.path)
    })

  const toggleMap = useCallback(() => {
    const saved = getSavedSpatialMapView(editor)
    if (zoom <= SPATIAL_MAP_ZOOM && saved) {
      editor.setCamera(saved.camera, { animation: { duration: 300 } })
      clearSavedSpatialMapView(editor)
      return
    }
    const bounds = spatialWorldBounds(nodes)
    if (!bounds) return
    saveSpatialMapView(editor, {
      camera: editor.getCamera(),
      sourceNodeId: currentSpatialDocument(editor, nodes)?.id ?? null,
    })
    zoomToSpatialWorld(editor, bounds, nodes.find(node => node.documentRef.kind === 'primary'))
  }, [editor, nodes, zoom])

  const activate = useCallback((nodeId: string) => {
    const node = nodes.find(candidate => candidate.id === nodeId)
    if (!node) return
    const saved = getSavedSpatialMapView(editor)
    const source = spatialMapActivationSource(editor, nodes)
    if (!source) return
    recordPlaceDeparture(editor)
    selectSpatialWorldNode(node.id)
    clearSavedSpatialMapView(editor)
    suppressFleetHudCameraTracking()
    openSpatialDocument(
      editor,
      source,
      node,
      saved?.camera ?? editor.getCamera(),
      readingPositionStore(project?.projectName ?? 'document'),
    )
  }, [editor, nodes, project?.projectName])

  return (
    <div className="doc-panel-content project-tab">
      {nodes.length > 0 && (
        <ProjectMapButton
          returning={zoom <= SPATIAL_MAP_ZOOM && !!getSavedSpatialMapView(editor)}
          onNavigate={toggleMap}
        />
      )}
      {visibleProjectRows.length === 0 && <div className="panel-empty">No documents found</div>}
      {visibleProjectRows.map(row => (
        <button
          type="button"
          key={row.key}
          className={`project-document-row${selectedNodeId === row.nodeId ? ' active' : ''}`}
          onClick={() => {
            setSelectedNodeId(row.nodeId)
            activate(row.nodeId)
          }}
        >
          {row.title}
        </button>
      ))}
    </div>
  )
}

// The live-canvas minimap rendered only the current tldraw page, and a book's
// chapters have lived on one page each since 9f24bd343 — so the "project map"
// was one chapter's rectangle in a grey box. A labelled button until a
// multi-page minimap exists.
function ProjectMapButton({
  returning,
  onNavigate,
}: {
  returning: boolean
  onNavigate: () => void
}) {
  return (
    <button
      type="button"
      className="project-map-navigate project-map-navigate-labelled"
      aria-label={returning ? 'Return to document view' : 'zoom out to project map'}
      title={returning ? 'Return to document view' : 'zoom out to project map'}
      onClick={onNavigate}
    >
      <svg width="14" height="14" viewBox="0 0 250 250" aria-hidden="true">
        <path
          d={returning ? 'M238 125 H12 M80 12 L12 125 L80 238' : 'M12 125 H238 M170 12 L238 125 L170 238'}
          fill="none"
          stroke="currentColor"
          strokeWidth="48"
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
      </svg>
      <span>{returning ? 'Return to document view' : 'zoom out to project map'}</span>
    </button>
  )
}
