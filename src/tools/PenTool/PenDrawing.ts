import { DrawShapeTool } from 'tldraw'
import type { Editor, TLStateNodeConstructor } from 'tldraw'
import { completePenCorrection } from './penCorrectionTarget'

const TldrawDrawing = DrawShapeTool.children().find(
  child => (child as unknown as { id: string }).id === 'drawing'
) as TLStateNodeConstructor

type DrawingState = { editor: Editor; complete(): void }

export class PenDrawing extends (TldrawDrawing as unknown as {
  new (...args: never[]): DrawingState
}) {
  static id = 'drawing'

  complete() {
    completePenCorrection(this.editor, () => super.complete())
  }
}
