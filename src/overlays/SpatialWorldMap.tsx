import { useSyncExternalStore } from 'react'
import { useEditor, useValue } from 'tldraw'
import {
  focusSpatialDocument,
  SPATIAL_MAP_ZOOM,
  spatialWorldDocuments,
  type SpatialWorldRoad,
} from '../spatialDocumentWorld'
import {
  getSpatialWorldUi,
  hoverSpatialWorldNode,
  selectSpatialWorldNode,
  subscribeSpatialWorldUi,
} from '../spatialDocumentWorldUi'
import './SpatialWorldMap.css'

export function SpatialWorldMap({ projectName }: { projectName: string }) {
  const editor = useEditor()
  const ui = useSyncExternalStore(subscribeSpatialWorldUi, getSpatialWorldUi)
  const map = useValue('spatial-document-world-map', () => {
    const zoom = editor.getZoomLevel()
    const camera = editor.getCamera()
    const nodes = spatialWorldDocuments(editor, projectName)
    if (zoom > SPATIAL_MAP_ZOOM) return { zoom, camera, labels: [], roads: [] }
    const byId = new Map(nodes.map(node => [node.id, node]))
    const labels = nodes
      .map((node) => {
        const topLeft = editor.pageToScreen({ x: node.bounds.x, y: node.bounds.y })
        const bottomRight = editor.pageToScreen({
          x: node.bounds.x + node.bounds.w,
          y: node.bounds.y + node.bounds.h,
        })
        return {
          id: node.id,
          title: node.title,
          node,
          x: topLeft.x,
          y: topLeft.y,
          w: bottomRight.x - topLeft.x,
          h: bottomRight.y - topLeft.y,
        }
      })
    const roads: Array<{
      id: string
      sourceId: string
      targetId: string
      x1: number
      y1: number
      x2: number
      y2: number
      strength: number
    }> = []
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
        const sourceCenter = editor.pageToScreen(road.sourcePoint || {
          x: source.bounds.x + source.bounds.w / 2,
          y: source.bounds.y + source.bounds.h / 2,
        })
        roads.push({
          id: `${road.sourceNodeId}-${target.id}`,
          sourceId: road.sourceNodeId,
          targetId: target.id,
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
    <div className="spatial-world-map">
      <svg className="spatial-world-roads">
        {map.roads.map(road => {
          const activeNodeId = ui.hoveredNodeId || ui.selectedNodeId
          const active = activeNodeId === road.sourceId || activeNodeId === road.targetId
          return (
            <line
              className={active ? 'active' : undefined}
              key={road.id}
              x1={road.x1}
              y1={road.y1}
              x2={road.x2}
              y2={road.y2}
              style={{ opacity: active ? 1 : road.strength, strokeWidth: 1.5 + road.strength }}
            />
          )
        })}
      </svg>
      {map.labels.map(label => {
        const active = ui.hoveredNodeId === label.id || ui.selectedNodeId === label.id
        return (
          <div
            className={`spatial-world-node${active ? ' active' : ''}`}
            key={label.id}
            style={{ left: label.x, top: label.y, width: label.w, height: label.h }}
          >
            <button
              type="button"
              className="spatial-world-label"
              onPointerEnter={() => hoverSpatialWorldNode(label.id)}
              onPointerLeave={() => hoverSpatialWorldNode(null)}
              onFocus={() => hoverSpatialWorldNode(label.id)}
              onBlur={() => hoverSpatialWorldNode(null)}
              onClick={() => {
                selectSpatialWorldNode(label.id)
                focusSpatialDocument(editor, label.node)
              }}
            >
              {label.title}
            </button>
          </div>
        )
      })}
    </div>
  )
}
