import { DrawShapeTool } from 'tldraw'
import type { TLStateNodeConstructor } from 'tldraw'
import { PenDrawing } from './PenDrawing'

export class PenTool extends DrawShapeTool {
  static override id = 'draw'

  static override children(): TLStateNodeConstructor[] {
    return super.children().map(child =>
      (child as unknown as { id: string }).id === 'drawing'
        ? (PenDrawing as unknown as TLStateNodeConstructor)
        : child
    )
  }
}
