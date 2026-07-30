import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
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
  const nodes = useValue(
    'spatial-document-world-nodes',
    () => spatialWorldDocuments(editor, projectName),
    [editor, projectName],
  )
  const documentRefs = useMemo(
    () => nodes.map(node => node.documentRef),
    [nodes],
  )
  const [associations, setAssociations] = useState<Array<{ source: string; target: string; weight: number }>>([])
  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/projects/${encodeURIComponent(projectName)}/document-associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents: documentRefs }),
      signal: controller.signal,
    })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then(result => setAssociations(Array.isArray(result.associations) ? result.associations : []))
      .catch(error => {
        if (error.name !== 'AbortError') setAssociations([])
      })
    return () => controller.abort()
  }, [documentRefs, projectName])
  const map = useValue('spatial-document-world-map', () => {
    const zoom = editor.getZoomLevel()
    const camera = editor.getCamera()
    if (zoom > SPATIAL_MAP_ZOOM) return { zoom, camera, labels: [], roads: [], associations: [] }
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
    const associationLines = associations.flatMap(edge => {
      const source = byId.get(edge.source)
      const target = byId.get(edge.target)
      if (!source || !target) return []
      const sourceCenter = editor.pageToScreen({
        x: source.bounds.x + source.bounds.w / 2,
        y: source.bounds.y + source.bounds.h / 2,
      })
      const targetCenter = editor.pageToScreen({
        x: target.bounds.x + target.bounds.w / 2,
        y: target.bounds.y + target.bounds.h / 2,
      })
      return [{
        id: `${edge.source}-${edge.target}`,
        x1: sourceCenter.x,
        y1: sourceCenter.y,
        x2: targetCenter.x,
        y2: targetCenter.y,
        weight: edge.weight,
      }]
    })
    return { zoom, camera, labels, roads, associations: associationLines }
  }, [associations, editor, nodes, projectName])

  if (map.zoom > SPATIAL_MAP_ZOOM) return null
  return (
    <div className="spatial-world-map">
      <svg className="spatial-world-roads">
        {map.associations.map(edge => (
          <line
            className="spatial-world-association"
            key={edge.id}
            x1={edge.x1}
            y1={edge.y1}
            x2={edge.x2}
            y2={edge.y2}
            style={{ opacity: 0.08 + edge.weight * 0.2, strokeWidth: 0.75 + edge.weight }}
          />
        ))}
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
