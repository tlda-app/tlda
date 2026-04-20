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

    // Commit shape at current position with final transcript — always expanded
    // so the user can immediately read and edit what was recorded
    editor.updateShape({
      id,
      type: 'math-note' as any,
      x: point.x - NOTE_W / 2,
      y: point.y - 10,
      props: { text: transcript, collapsed: false },
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
    editor.setEditingShape(id)
    editor.setCurrentTool('select')
  }

  override onKeyDown = (info: any) => {
    if (info.key === 'Escape') {
      if (_stopRecording) { _stopRecording(); _stopRecording = null }
      // ESC cancels — delete the shape (nothing was committed)
      if (this._shapeId) {
        this.editor.deleteShape(this._shapeId)
        this._shapeId = null
      }
      this.editor.setCurrentTool('select')
    }
  }

  override onExit = () => {
    // Shape stays on canvas — ESC is the only explicit cancel.
    // If the tool exits via any other path (click-commit, tool switch, etc.)
    // the shape was either committed or should survive for the user to edit.
    this._shapeId = null
  }
}
