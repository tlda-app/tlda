import { StateNode, createShapeId, DefaultColorStyle, type JsonObject } from 'tldraw'
import { currentDocumentInfo } from '../svgDocumentLoader'
import { annotationSourceAnchorAtCanvasPoint, type AnnotationSourceAnchor } from '../annotationSourceAnchor'
import { NOTE_COLORS } from '../shapes/MathNoteShape'

const NOTE_W = 200
const NOTE_H = 50

function annotationAnchorLabel(anchor: AnnotationSourceAnchor): string {
  if (anchor.anchored === false) return anchor.reason
  return `${anchor.file}:${anchor.line}`
}

export class MathNoteTool extends StateNode {
  static override id = 'math-note'

  private preview: HTMLDivElement | null = null

  private getActiveColor(): string {
    const color = this.editor.getStyleForNextShape(DefaultColorStyle)
    return NOTE_COLORS[color] ? color : 'light-blue'
  }

  private getPreviewColor(): string {
    return NOTE_COLORS[this.getActiveColor()]
  }

  override onEnter = () => {
    const container = this.editor.getContainer()
    const el = document.createElement('div')
    const bg = this.getPreviewColor()
    el.style.cssText = `
      position: absolute; pointer-events: none; z-index: 9999;
      width: ${NOTE_W}px; height: ${NOTE_H}px;
      background: ${bg}80;
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
    // Update color in case it changed
    const bg = this.getPreviewColor()
    this.preview.style.background = `${bg}80`
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
    let sourceAnchor: AnnotationSourceAnchor | null = null
    if (currentDocumentInfo) {
      sourceAnchor = await annotationSourceAnchorAtCanvasPoint(editor, currentDocumentInfo, point.x, point.y)
    }

    editor.createShape({
      id,
      type: 'math-note' as any,
      x: point.x - NOTE_W / 2,
      y: point.y - NOTE_H / 2,
      meta: { createdAt: Date.now(), ...(sourceAnchor ? { sourceAnchor } : {}) } as unknown as Partial<JsonObject>,
      props: {
        w: NOTE_W,
        h: NOTE_H,
        text: '',
        color: this.getActiveColor(),
      },
    })

    // Log anchor for debugging
    if (sourceAnchor) {
      console.log(`[Anchor] Note anchored to ${annotationAnchorLabel(sourceAnchor)}`)
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
