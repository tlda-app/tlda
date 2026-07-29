import { useEditor, useValue } from 'tldraw'
import { SPATIAL_MAP_ZOOM, spatialWorldDocuments, type SpatialWorldRoad } from '../spatialDocumentWorld'
import './SpatialWorldMap.css'

export function SpatialWorldMap({ projectName }: { projectName: string }) {
  const editor = useEditor()
  const map = useValue('spatial-document-world-map', () => {
    const zoom = editor.getZoomLevel()
    const camera = editor.getCamera()
    const nodes = spatialWorldDocuments(editor, projectName)
    if (zoom > SPATIAL_MAP_ZOOM) return { zoom, camera, labels: [], roads: [] }
    const byId = new Map(nodes.map(node => [node.id, node]))
    const labels = nodes
      .map((node) => {
        const point = editor.pageToScreen({
          x: node.bounds.x + node.bounds.w / 2,
          y: node.bounds.y,
        })
        return { id: node.id, title: node.title, x: point.x, y: point.y }
      })
    const roads: Array<{ id: string; x1: number; y1: number; x2: number; y2: number; strength: number }> = []
    for (const target of nodes) {
      if (!target.shape) continue
      const targetCenter = editor.pageToScreen({
        x: target.bounds.x + target.bounds.w / 2,
        y: target.bounds.y + target.bounds.h / 2,
      })
      const targetRoads = Array.isArray(target.shape.meta?.spatialWorldRoads)
        ? target.shape.meta.spatialWorldRoads as SpatialWorldRoad[]
        : []
      for (const road of targetRoads) {
        const source = byId.get(road.sourceNodeId)
        if (!source) continue
        const sourceCenter = editor.pageToScreen({
          x: source.bounds.x + source.bounds.w / 2,
          y: source.bounds.y + source.bounds.h / 2,
        })
        roads.push({
          id: `${road.sourceNodeId}-${target.id}`,
          x1: sourceCenter.x,
          y1: sourceCenter.y,
          x2: targetCenter.x,
          y2: targetCenter.y,
          strength: road.strength,
        })
      }
    }
    return { zoom, camera, labels, roads }
  }, [editor, projectName])

  if (map.zoom > SPATIAL_MAP_ZOOM) return null
  return (
    <div className="spatial-world-map" aria-hidden="true">
      <svg className="spatial-world-roads">
        {map.roads.map(road => (
          <line
            key={road.id}
            x1={road.x1}
            y1={road.y1}
            x2={road.x2}
            y2={road.y2}
            style={{ opacity: road.strength, strokeWidth: 1.5 + road.strength }}
          />
        ))}
      </svg>
      {map.labels.map(label => (
        <div
          className="spatial-world-label"
          key={label.id}
          style={{ left: label.x, top: label.y }}
        >
          {label.title}
        </div>
      ))}
    </div>
  )
}
