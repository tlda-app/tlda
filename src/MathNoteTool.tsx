import { StateNode, createShapeId, type JsonObject } from 'tldraw'
import { currentDocumentInfo } from './SvgDocument'
import { getSourceAnchor, canvasToPdf, type SourceAnchor } from './synctexAnchor'

export class MathNoteTool extends StateNode {
  static override id = 'math-note'

  override onPointerDown = async () => {
    const { editor } = this
    const point = editor.inputs.currentPagePoint

    const id = createShapeId()

    // Try to get source anchor for this position
    let sourceAnchor: SourceAnchor | null = null
    if (currentDocumentInfo) {
      const pdfPos = canvasToPdf(point.x, point.y, currentDocumentInfo.pages)
      if (pdfPos) {
        sourceAnchor = await getSourceAnchor(
          currentDocumentInfo.name,
          pdfPos.page,
          pdfPos.x,
          pdfPos.y
        )
      }
    }

    editor.createShape({
      id,
      type: 'math-note' as any,
      x: point.x - 100,
      y: point.y - 100,
      meta: (sourceAnchor ? { sourceAnchor } : {}) as Partial<JsonObject>,
      props: {
        w: 200,
        h: 200,
        text: '',
        color: 'yellow',
      },
    })

    // Log anchor for debugging
    if (sourceAnchor) {
      console.log(`[SyncTeX] Note anchored to ${sourceAnchor.file}:${sourceAnchor.line}`)
    }

    editor.setEditingShape(id)
    editor.setCurrentTool('select')
  }
}
