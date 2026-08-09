import { getArrowInfo, type Editor, type TLArrowShape, type TLShapeId } from 'tldraw'
import { isClassroomConnectorArrow, type PointLike } from './connectorGeometry'

export interface ClassroomConnector {
  id: TLShapeId
  from: PointLike
  to: PointLike
  color: string
  selected: boolean
}

function colorToStroke(color: unknown): string {
  switch (color) {
    case 'red': return '#d73a31'
    case 'orange': return '#c76b16'
    case 'yellow': return '#a87500'
    case 'green': return '#2f7d46'
    case 'light-green': return '#4d8f5b'
    case 'blue': return '#2563eb'
    case 'light-blue': return '#287d9f'
    case 'violet': return '#7c3aed'
    case 'light-violet': return '#8b5cf6'
    case 'black': return '#222222'
    case 'grey': return '#5f6368'
    case 'white': return '#f8f8f8'
    default: return '#5f6368'
  }
}

function arrowTerminalPagePoints(editor: Editor, arrow: TLArrowShape) {
  const info = getArrowInfo(editor, arrow)
  const transform = editor.getShapePageTransform(arrow)
  if (!info || !transform) return null
  return {
    start: transform.applyToPoint(info.start.point),
    end: transform.applyToPoint(info.end.point),
  }
}

export function classroomConnectorsForEditor(
  editor: Editor,
  submissionShapeId: TLShapeId,
  solutionShapeId: TLShapeId,
): ClassroomConnector[] {
  const submissionBounds = editor.getShapePageBounds(submissionShapeId)
  const solutionBounds = editor.getShapePageBounds(solutionShapeId)
  if (!submissionBounds || !solutionBounds) return []

  const selected = new Set(editor.getSelectedShapeIds())
  return editor.getCurrentPageShapes()
    .filter((shape): shape is TLArrowShape => shape.type === 'arrow')
    .map(arrow => {
      const terminals = arrowTerminalPagePoints(editor, arrow)
      if (!terminals) return null
      if (!isClassroomConnectorArrow(terminals.start, terminals.end, submissionBounds, solutionBounds)) return null
      const from = editor.pageToScreen(terminals.start)
      const to = editor.pageToScreen(terminals.end)
      return {
        id: arrow.id,
        from: { x: from.x, y: from.y },
        to: { x: to.x, y: to.y },
        color: colorToStroke(arrow.props.color),
        selected: selected.has(arrow.id),
      }
    })
    .filter((connector): connector is ClassroomConnector => connector !== null)
}
