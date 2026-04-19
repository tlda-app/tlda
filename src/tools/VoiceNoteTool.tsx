/**
 * VoiceNoteTool — placement StateNode for voice notes.
 *
 * Entered programmatically after the voice note button is tapped.
 * A real math-note shape is created immediately and follows the cursor while
 * recording. Live transcript streams into the shape via getTranscript().
 * On tap: the shape is committed in place. On ESC: shape is deleted if empty.
 */
import { StateNode, createShapeId, type TLShapeId, type JsonObject } from 'tldraw'
import { currentDocumentInfo } from '../svgDocumentLoader'
import { getSourceAnchor, canvasToPdf, type SourceAnchor } from '../synctexAnchor'
import { getTranscript } from '../voice.mjs'
import { log } from '../logger'

let _stopRecording: (() => void) | null = null

export function setStopRecordingCallback(fn: (() => void) | null) {
  _stopRecording = fn
}

// A6 paper width in canvas units — wide enough to read, small enough to drag
const NOTE_W = 300

export class VoiceNoteTool extends StateNode {
  static override id = 'voice-note'

  private _shapeId: TLShapeId | null = null

  override onEnter = () => {
    const { editor } = this
    const point = editor.inputs.currentPagePoint
    const id = createShapeId()
    this._shapeId = id
    editor.createShape({
      id,
      type: 'math-note' as any,
      x: point.x - NOTE_W / 2,
      y: point.y - 10,
      props: { w: NOTE_W, h: 50, text: '', color: 'yellow', autoSize: true, collapsed: false },
    })
  }

  override onPointerMove = () => {
    if (!this._shapeId) return
    const { editor } = this
    const point = editor.inputs.currentPagePoint
    const transcript = getTranscript()
    editor.updateShape({
      id: this._shapeId,
      type: 'math-note' as any,
      x: point.x - NOTE_W / 2,
      y: point.y - 10,
      props: { text: transcript },
    })
  }

  override onPointerDown = () => {
    // No-op: let pointer flow to pointerUp for commit
  }

  override onPointerUp = () => {
    if (!this._shapeId) return
    const { editor } = this
    const id = this._shapeId
    const point = { ...editor.inputs.currentPagePoint }

    // Snapshot transcript before stopping recording (stop may clear voice state)
    const transcript = getTranscript()
    if (_stopRecording) { _stopRecording(); _stopRecording = null }

    // Commit shape at current position with final transcript
    editor.updateShape({
      id,
      type: 'math-note' as any,
      x: point.x - NOTE_W / 2,
      y: point.y - 10,
      props: {
        text: transcript,
        collapsed: transcript.length > 0,
      },
      meta: { voiceNote: true, rawTranscript: transcript } as Partial<JsonObject>,
    })

    // Async: resolve synctex anchor and attach it
    if (currentDocumentInfo) {
      const pdfPos = canvasToPdf(point.x, point.y, currentDocumentInfo.pages)
      if (pdfPos) {
        getSourceAnchor(currentDocumentInfo.name, pdfPos.page, pdfPos.x, pdfPos.y)
          .then((sourceAnchor: SourceAnchor | null) => {
            if (sourceAnchor) {
              editor.updateShape({
                id,
                type: 'math-note' as any,
                meta: { voiceNote: true, rawTranscript: transcript, sourceAnchor } as any,
              })
            }
          })
          .catch(() => {})
      }
    }

    log.debug('voice', 'VoiceNoteTool committed', { transcriptLen: transcript.length })
    this._shapeId = null
    editor.setCurrentTool('select')
  }

  override onKeyDown = (info: any) => {
    if (info.key === 'Escape') {
      if (_stopRecording) { _stopRecording(); _stopRecording = null }
      this._deleteShapeIfEmpty()
      this._shapeId = null
      this.editor.setCurrentTool('select')
    }
  }

  override onExit = () => {
    // If tool was cancelled without committing, clean up empty shape
    if (this._shapeId) {
      this._deleteShapeIfEmpty()
      this._shapeId = null
    }
  }

  private _deleteShapeIfEmpty() {
    if (!this._shapeId) return
    const shape = this.editor.getShape(this._shapeId) as any
    if (!shape) return
    if (!shape.props?.text) {
      this.editor.deleteShape(this._shapeId)
    }
  }
}
