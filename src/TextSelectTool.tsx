import { StateNode } from 'tldraw'
import { writeSignal } from './useYjsSync'

/**
 * Custom tool that activates native SVG text selection mode.
 * When active, CSS overrides enable user-select on SVG text elements,
 * and a selectionchange listener sends selected text to Yjs.
 */
export class TextSelectTool extends StateNode {
  static override id = 'text-select'
  private _onSelectionChange: (() => void) | null = null

  override onEnter = () => {
    this.editor.setCursor({ type: 'text', rotation: 0 })
    document.body.classList.add('text-select-mode')

    // Listen for selection changes and write to Yjs
    this._onSelectionChange = () => {
      const sel = window.getSelection()
      const text = sel?.toString()
      if (!text?.trim()) return

      writeSignal('signal:text-selection', { text })
    }
    document.addEventListener('selectionchange', this._onSelectionChange)
  }

  override onExit = () => {
    this.editor.setCursor({ type: 'default', rotation: 0 })
    document.body.classList.remove('text-select-mode')

    if (this._onSelectionChange) {
      document.removeEventListener('selectionchange', this._onSelectionChange)
      this._onSelectionChange = null
    }
  }

  // Let pointer events pass through to the SVG text elements
  override onPointerDown = () => {}
  override onPointerMove = () => {}
  override onPointerUp = () => {}
}
