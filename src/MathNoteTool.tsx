import { StateNode, createShapeId, type JsonObject } from 'tldraw'
import { currentDocumentInfo } from './svgDocumentLoader'
import { getSourceAnchor, canvasToPdf, type SourceAnchor } from './synctexAnchor'

const NOTE_W = 200
const NOTE_H = 50

export class MathNoteTool extends StateNode {
  static override id = 'math-note'

  private preview: HTMLDivElement | null = null

  override onEnter = () => {
    const container = this.editor.getContainer()
    const el = document.createElement('div')
    el.style.cssText = `
      position: absolute; pointer-events: none; z-index: 9999;
      width: ${NOTE_W}px; height: ${NOTE_H}px;
      background: rgba(191, 219, 254, 0.5);
      border-radius: 4px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.12);
      display: none;
    `
    container.appendChild(el)
    this.preview = el
  }

  override onPointerMove = () => {
    if (!this.preview) return
    const point = this.editor.inputs.currentPagePoint
    const screen = this.editor.pageToViewport({ x: point.x - NOTE_W / 2, y: point.y - NOTE_H / 2 })
    this.preview.style.left = `${screen.x}px`
    this.preview.style.top = `${screen.y}px`
    this.preview.style.display = 'block'
    // Scale preview to match camera zoom
    const zoom = this.editor.getZoomLevel()
    this.preview.style.transform = `scale(${zoom})`
    this.preview.style.transformOrigin = 'top left'
  }

  override onPointerDown = async () => {
    this.removePreview()
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
      x: point.x - NOTE_W / 2,
      y: point.y - NOTE_H / 2,
      meta: (sourceAnchor ? { sourceAnchor } : {}) as Partial<JsonObject>,
      props: {
        w: NOTE_W,
        h: NOTE_H,
        text: '',
      },
    })

    // Log anchor for debugging
    if (sourceAnchor) {
      console.log(`[SyncTeX] Note anchored to ${sourceAnchor.file}:${sourceAnchor.line}`)
    }

    editor.setEditingShape(id)
    editor.setCurrentTool('select')
  }

  override onExit = () => {
    this.removePreview()
  }

  private removePreview() {
    if (this.preview) {
      this.preview.remove()
      this.preview = null
    }
  }
}
