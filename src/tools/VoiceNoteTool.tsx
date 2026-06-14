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
import { getPref } from '../preferences'

let _stopRecording: (() => void) | null = null

export function setStopRecordingCallback(fn: (() => void) | null) {
  _stopRecording = fn
}

// A6 paper width in canvas units — wide enough to read, small enough to drag
const NOTE_W = 300

export class VoiceNoteTool extends StateNode {
  static override id = 'voice-note'

  private _shapeId: TLShapeId | null = null
  private _transcriptInterval: ReturnType<typeof setInterval> | null = null

  private _clearInterval() {
    if (this._transcriptInterval) {
      clearInterval(this._transcriptInterval)
      this._transcriptInterval = null
    }
  }

  // info.initialPoint (page coords) seeds the ghost when there's no cursor to
  // start from — the touch button passes a point just left of itself. Mouse
  // entry passes nothing and uses the live cursor position.
  override onEnter = (info?: { initialPoint?: { x: number; y: number } }) => {
    const { editor } = this
    const point = info?.initialPoint ?? editor.inputs.currentPagePoint
    const id = createShapeId()
    this._shapeId = id
    editor.createShape({
      id,
      type: 'math-note' as any,
      x: point.x - NOTE_W / 2,
      y: point.y - 10,
      props: { w: NOTE_W, h: 50, text: '', color: getPref('voice-note-color'), autoSize: true, collapsed: false },
      meta: { createdAt: Date.now() } as Partial<JsonObject>,
    })
    // Poll transcript at 50ms so ghost text updates continuously, not just on pointer move
    this._transcriptInterval = setInterval(() => {
      if (!this._shapeId) { this._clearInterval(); return }
      this.editor.updateShape({
        id: this._shapeId,
        type: 'math-note' as any,
        props: { text: getTranscript() },
      })
    }, 50)
  }

  override onPointerMove = () => {
    if (!this._shapeId) return
    const { editor } = this
    const point = editor.inputs.currentPagePoint
    // Interval handles text updates; just track position here
    editor.updateShape({
      id: this._shapeId,
      type: 'math-note' as any,
      x: point.x - NOTE_W / 2,
      y: point.y - 10,
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

    // Snapshot transcript and stop interval — but do NOT stop recording.
    // setEditingShape below puts the note in edit mode, which registers its
    // own voice accumulator, so recording continues seamlessly without the
    // user needing to tap shift again.
    const transcript = getTranscript()
    this._clearInterval()

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
          .catch(e => console.warn('[voice-note] update shape failed:', e.message))
      }
    }

    log.debug('voice', 'VoiceNoteTool committed', { transcriptLen: transcript.length })
    this._shapeId = null
    editor.setEditingShape(id)
    editor.setCurrentTool('select')
  }

  override onKeyDown = (info: any) => {
    if (info.key === 'Escape') {
      this._clearInterval()
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
    this._clearInterval()
    this._shapeId = null
  }
}
