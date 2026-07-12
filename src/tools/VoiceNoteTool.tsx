/**
 * VoiceNoteTool — placement StateNode for voice notes.
 *
 * Entered programmatically after the voice note button is tapped.
 * A real math-note shape is created immediately and follows the cursor while
 * recording. Live transcript streams into the shape via getTranscript().
 * On tap: the shape is committed in place. On ESC: shape is deleted if empty.
 */
import { StateNode, createShapeId, type TLShapeId, type TLShapePartial, type JsonObject } from 'tldraw'
import { currentDocumentInfo } from '../svgDocumentLoader'
import { annotationSourceAnchorAtCanvasPoint, type AnnotationSourceAnchor } from '../annotationSourceAnchor'
import { getTranscript, resetTranscript, setVoiceAccumulator } from '../voice.mjs'
import { log } from '../logger'
import { getPref } from '../preferences'

let _stopRecording: (() => void) | null = null
let _finishPlacement: (() => void) | null = null

export function setStopRecordingCallback(fn: (() => void) | null) {
  _stopRecording = fn
}

export function setFinishPlacementCallback(fn: (() => void) | null) {
  _finishPlacement = fn
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
    editor.markHistoryStoppingPoint('voice note')
    // Start every new voice note with a clean transcript buffer. Without this,
    // a previous note's leftover `_left`/`_interim` bleeds into the new note
    // (content from note 1 reappears in / displaces note 2). Resetting clears
    // the live buffer; the just-committed note keeps its own saved text.
    resetTranscript()
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

    // Snapshot the final transcript and stop the live-update interval. Recording
    // is stopped at the end of this commit (see below) so the note is finished
    // and the next voice-button tap starts a fresh note.
    const transcript = getTranscript()
    this._clearInterval()

    // Commit shape at current position with final transcript — always expanded
    // so the user can immediately read and edit what was recorded
    editor.updateShape({
      id,
      type: 'math-note',
      x: point.x - NOTE_W / 2,
      y: point.y - 10,
      props: { text: transcript, collapsed: false },
      meta: { voiceNote: true, rawTranscript: transcript } as Partial<JsonObject>,
    } as unknown as TLShapePartial)

    // Async: resolve source anchor and attach it
    if (currentDocumentInfo) {
      annotationSourceAnchorAtCanvasPoint(editor, currentDocumentInfo, point.x, point.y)
        .then((sourceAnchor: AnnotationSourceAnchor | null) => {
          if (sourceAnchor) {
            editor.updateShape({
              id,
              type: 'math-note',
              meta: { voiceNote: true, rawTranscript: transcript, sourceAnchor } as Partial<JsonObject>,
            } as unknown as TLShapePartial)
          }
        })
        .catch(e => console.warn('[voice-note] update shape failed:', e.message))
    }

    let base = transcript
    const onUpdate = (text: string) => {
      const next = base + (base && text ? (/\s$/.test(base) ? '' : ' ') : '') + text
      editor.updateShape({ id, type: 'math-note' as any, props: { text: next } })
    }
    const onStop = () => {
      const shape = editor.getShape(id) as any
      base = shape?.props?.text || base
    }
    resetTranscript(transcript)
    setVoiceAccumulator(onUpdate, null, onStop, 'note')

    log.debug('voice', 'VoiceNoteTool committed', { transcriptLen: transcript.length })
    this._shapeId = null
    // Finish placement without stopping the recorder. The committed note becomes
    // the voice accumulator, so continued speech appends into it until another
    // target is chosen.
    if (_finishPlacement) { _finishPlacement(); _finishPlacement = null }
    editor.setCurrentTool('select')
    editor.setSelectedShapes([])
  }

  override onKeyDown = (info: any) => {
    if (info.key === 'Escape') {
      this._clearInterval()
      if (_stopRecording) { _stopRecording(); _stopRecording = null }
      _finishPlacement = null
      // ESC cancels — delete the shape (nothing was committed)
      if (this._shapeId) {
        this.editor.deleteShape(this._shapeId)
        this._shapeId = null
      }
      this.editor.setCurrentTool('select')
    }
  }

  override onExit = () => {
    if (this._shapeId) {
      const shape = this.editor.getShape(this._shapeId)
      const props = shape?.props as { text?: unknown } | undefined
      const text = typeof props?.text === 'string' ? props.text : ''
      if (text.trim() === '') this.editor.deleteShape(this._shapeId)
    }
    this._clearInterval()
    this._shapeId = null
  }
}
