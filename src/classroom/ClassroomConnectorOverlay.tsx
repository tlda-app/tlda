import { useEffect, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import {
  classroomConnectorsForEditor,
  type ClassroomConnector,
} from './connectors'
import { connectorArrowheadPoints } from './connectorGeometry'

interface ClassroomConnectorOverlayProps {
  editor: Editor
  submissionShapeId: TLShapeId
  solutionShapeId: TLShapeId
}

function sameConnectors(a: ClassroomConnector[], b: ClassroomConnector[]) {
  if (a.length !== b.length) return false
  return a.every((left, i) => {
    const right = b[i]
    return right &&
      left.id === right.id &&
      left.color === right.color &&
      left.selected === right.selected &&
      left.from.x === right.from.x &&
      left.from.y === right.from.y &&
      left.to.x === right.to.x &&
      left.to.y === right.to.y
  })
}

export function ClassroomConnectorOverlay({
  editor,
  submissionShapeId,
  solutionShapeId,
}: ClassroomConnectorOverlayProps) {
  const [connectors, setConnectors] = useState<ClassroomConnector[]>([])

  useEffect(() => {
    let live = true
    let frame = 0
    const refresh = () => {
      if (!live) return
      const next = classroomConnectorsForEditor(editor, submissionShapeId, solutionShapeId)
      setConnectors(prev => sameConnectors(prev, next) ? prev : next)
      frame = requestAnimationFrame(refresh)
    }
    frame = requestAnimationFrame(refresh)
    return () => {
      live = false
      cancelAnimationFrame(frame)
    }
  }, [editor, submissionShapeId, solutionShapeId])

  if (!connectors.length) return null

  return (
    <svg
      aria-hidden="true"
      className="classroomConnectorOverlay"
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: 1000,
      }}
    >
      {connectors.map(connector => {
        const d = `M ${connector.from.x} ${connector.from.y} L ${connector.to.x} ${connector.to.y}`
        const strokeWidth = connector.selected ? 3.5 : 2.5
        return (
          <g key={connector.id}>
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={18}
              strokeLinecap="round"
              pointerEvents="stroke"
              onPointerDown={event => {
                event.preventDefault()
                event.stopPropagation()
                editor.select(connector.id)
              }}
            />
            <path
              d={d}
              fill="none"
              stroke={connector.color}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              opacity={connector.selected ? 1 : 0.88}
              pointerEvents="none"
            />
            <polygon
              points={connectorArrowheadPoints(connector.from, connector.to, connector.selected ? 12 : 10)}
              fill={connector.color}
              opacity={connector.selected ? 1 : 0.88}
              pointerEvents="none"
            />
          </g>
        )
      })}
    </svg>
  )
}
