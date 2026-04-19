/**
 * VoiceNoteTool — placement StateNode for voice notes.
 *
 * Entered programmatically after the voice note button is tapped.
 * Shows a mic-dot ghost that follows the cursor/pen. On tap, reads the
 * current transcript from the voice system and places a math-note.
 *
 * The stop callback (set by DocumentPanel) snapshots the transcript and
 * stops the voice system before commitVoiceNote() reads it.
 */
import { StateNode, createShapeId, type JsonObject } from 'tldraw'
import { currentDocumentInfo } from '../svgDocumentLoader'
import { getSourceAnchor, canvasToPdf, type SourceAnchor } from '../synctexAnchor'
import { log } from '../logger'

let _pendingTranscript = ''
let _stopRecording: (() => void) | null = null
let _pendingPlacement: { point: { x: number; y: number }; editor: any } | null = null

export function setPendingVoiceTranscript(text: string) {
  _pendingTranscript = text
}

export function setStopRecordingCallback(fn: (() => void) | null) {
  _stopRecording = fn
}

export function setPendingPlacement(point: { x: number; y: number }, editor: any) {
  _pendingPlacement = { point, editor }
}

export function clearPendingPlacement() {
  _pendingPlacement = null
}

export function commitVoiceNote() {
  const placement = _pendingPlacement
  const transcript = _pendingTranscript
  _pendingPlacement = null
  _pendingTranscript = ''

  if (!placement) {
    log.warn('voice', 'commitVoiceNote bail — no placement')
    return
  }
  log.debug('voice', 'commitVoiceNote', { transcriptLen: transcript.length })

  const { point, editor } = placement
  const id = createShapeId()

  editor.createShape({
    id,
    type: 'math-note' as any,
    x: point.x - 100,
    y: point.y - 25,
    meta: { voiceNote: true, rawTranscript: transcript } as Partial<JsonObject>,
    props: { w: 200, h: 50, text: transcript, color: 'yellow', collapsed: transcript.length > 0 },
  })

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
}

const DOT_R = 8

export class VoiceNoteTool extends StateNode {
  static override id = 'voice-note'

  private ghost: HTMLDivElement | null = null

  override onEnter = () => {
    const container = this.editor.getContainer()
    const el = document.createElement('div')
    el.style.cssText = `
      position: absolute; pointer-events: none; z-index: 9999;
      width: ${DOT_R * 2}px; height: ${DOT_R * 2}px;
      background: #ef4444;
      border-radius: 50%;
      box-shadow: 0 0 0 4px rgba(239,68,68,0.25);
      display: none;
    `
    container.appendChild(el)
    this.ghost = el
  }

  override onPointerMove = () => {
    if (!this.ghost) return
    const point = this.editor.inputs.currentPagePoint
    const screen = this.editor.pageToViewport({ x: point.x - DOT_R, y: point.y - DOT_R })
    this.ghost.style.left = `${screen.x}px`
    this.ghost.style.top = `${screen.y}px`
    this.ghost.style.display = 'block'
  }

  override onPointerDown = () => {
    if (this.ghost) this.ghost.style.display = 'none'
  }

  override onPointerUp = () => {
    const { editor } = this
    const point = { ...editor.inputs.currentPagePoint }
    setPendingPlacement(point, editor)
    // Stop callback snapshots transcript from voice system before we commit
    if (_stopRecording) { _stopRecording(); _stopRecording = null }
    commitVoiceNote()
    editor.setCurrentTool('select')
  }

  override onKeyDown = (info: any) => {
    if (info.key === 'Escape') {
      if (_stopRecording) { _stopRecording(); _stopRecording = null }
      _pendingTranscript = ''
      _pendingPlacement = null
      this.editor.setCurrentTool('select')
    }
  }

  override onExit = () => {
    this.removeGhost()
  }

  private removeGhost() {
    if (this.ghost) {
      this.ghost.remove()
      this.ghost = null
    }
  }
}
