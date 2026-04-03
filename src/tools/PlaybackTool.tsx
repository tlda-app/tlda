import { StateNode, createShapeId } from 'tldraw'

const FRAME_W = 500
const FRAME_H = 740

export class PlaybackTool extends StateNode {
  static override id = 'playback-frame'

  override onPointerDown = () => {
    const { editor } = this
    const point = editor.inputs.currentPagePoint
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'playback-frame',
      x: point.x - FRAME_W / 2,
      y: point.y,
      props: { w: FRAME_W, h: FRAME_H, playbackId: '', mode: 'free' },
    })
    editor.setCurrentTool('select')
    editor.select(id)
  }
}
