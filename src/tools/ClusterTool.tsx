import { StateNode, createShapeId } from 'tldraw'

const CLUSTER_W = 480
const CLUSTER_H = 340

export class ClusterTool extends StateNode {
  static override id = 'cluster'

  override onPointerDown = () => {
    const { editor } = this
    const point = editor.inputs.currentPagePoint
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'cluster' as any,
      x: point.x - CLUSTER_W / 2,
      y: point.y - CLUSTER_H / 2,
      props: { w: CLUSTER_W, h: CLUSTER_H },
    })
    editor.setCurrentTool('select')
    editor.select(id)
  }
}
