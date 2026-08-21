import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useEditor, useValue, type Editor } from 'tldraw'
import { CanvasClipPanel } from '../CanvasClipPanel'
import { ProjectContext } from '../PanelContext'
import { recordPlaceDeparture } from '../placeStack'
import {
  SPATIAL_MAP_ZOOM,
  clearSavedSpatialMapView,
  currentSpatialDocument,
  placeSpatialDocument,
  getSavedSpatialMapView,
  openSpatialDocument,
  saveSpatialMapView,
  spatialWorldBounds,
  spatialWorldDocuments,
  spatialDocumentIdentity,
  spatialDocumentShapeId,
  spatialMapActivationSource,
  zoomToSpatialWorld,
} from '../spatialDocumentWorld'
import {
  getSpatialWorldUi,
  hoverSpatialWorldNode,
  selectSpatialWorldNode,
  subscribeSpatialWorldUi,
} from '../spatialDocumentWorldUi'
import { suppressFleetHudCameraTracking } from '../wm/fleet-hud-state'
import { readingPositionStore } from '../readingPositionStore'
import { isProjectMapShape } from './project-map-shape-predicate'

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
  const ui = useSyncExternalStore(subscribeSpatialWorldUi, getSpatialWorldUi)
  const [projectDocuments, setProjectDocuments] = useState<ProjectDocument[]>([])
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
  const placedOutputFiles = new Set(nodes.map(node => node.documentRef.path).filter(Boolean))
  // The main document is represented by the primary spatial node. Every root
  // that is not already represented by a spatial node remains selectable here.
  const unplacedDocuments = projectDocuments.filter(document =>
    !placedOutputFiles.has(document.outputFile)
  )
  const normalizedQuery = query.trim().toLowerCase()
  const visibleNodes = nodes.filter(node =>
    !normalizedQuery || node.title.toLowerCase().includes(normalizedQuery)
  )
  const visibleUnplacedDocuments = unplacedDocuments.filter(document =>
    !normalizedQuery || document.title.toLowerCase().includes(normalizedQuery)
  )

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

  const activateUnplaced = useCallback(async (document: ProjectDocument) => {
    if (!project?.projectName) return
    const source = currentSpatialDocument(editor, nodes)
    if (!source) return
    const url = `/docs/${encodeURIComponent(project.projectName)}/${document.outputFile}`
    const identity = spatialDocumentIdentity(document.title, url, {
      materializedFile: document.outputFile,
    })
    const shapeId = spatialDocumentShapeId(identity)
    const existing = editor.getShape(shapeId)
    if (!existing) {
      const point = editor.getViewportPageBounds().center
      const bounds = placeSpatialDocument(editor, identity, source, { w: 800, h: 1200 }, point)
      editor.createShape({
        id: shapeId,
        type: document.format === 'svg' ? 'svg-page' : 'html-page',
        x: bounds.x,
        y: bounds.y,
        isLocked: true,
        props: {
          w: 800,
          h: 1200,
          url,
          ...(document.format === 'svg' ? { pageIndex: 0 } : {}),
        },
        meta: {
          spatialWorldDocument: true,
          spatialWorldIdentity: identity,
          spatialWorldTitle: document.title,
          materializedDoc: project.projectName,
          materializedFile: document.outputFile,
        },
      } as never)
    }
    const target = spatialWorldDocuments(editor, project.projectName, project.title)
      .find(node => node.id === shapeId)
    if (!target) return
    recordPlaceDeparture(editor)
    suppressFleetHudCameraTracking()
    openSpatialDocument(
      editor,
      source,
      target,
      editor.getCamera(),
      readingPositionStore(project.projectName),
    )
  }, [editor, nodes, project?.projectName, project?.title])

  return (
    <div className="doc-panel-content project-tab">
      <ProjectMapViewport
        editor={editor}
        bounds={spatialWorldBounds(nodes)}
        returning={zoom <= SPATIAL_MAP_ZOOM && !!getSavedSpatialMapView(editor)}
        onNavigate={toggleMap}
      />
      {visibleNodes.length === 0 && visibleUnplacedDocuments.length === 0 && <div className="panel-empty">No documents found</div>}
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
      {visibleUnplacedDocuments.map(document => (
        <button
          type="button"
          key={document.outputFile}
          className="project-document-row"
          onClick={() => void activateUnplaced(document)}
        >
          {document.title}
        </button>
      ))}
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
          shapePredicate={isProjectMapShape}
          interactionMode="pinned"
          fitBounds
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
