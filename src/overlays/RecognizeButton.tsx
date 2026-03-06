/**
 * Floating "recognize" button that appears near selected draw shapes.
 * Tap to send strokes to MyScript and attach LaTeX transcription as metadata.
 */

import { useState, useCallback } from 'react'
import './RecognizeButton.css'
import { useEditor, useValue, stopEventPropagation } from 'tldraw'
import { canRecognize, recognizeSelection } from '../handwritingRecognize'

export function RecognizeButton() {
  const editor = useEditor()
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')

  // Track whether current selection is recognizable
  const show = useValue('canRecognize', () => canRecognize(editor), [editor])

  // Track selection bounds for positioning
  const bounds = useValue('selectionBounds', () => {
    if (!canRecognize(editor)) return null
    return editor.getSelectionRotatedPageBounds()
  }, [editor])

  const handleRecognize = useCallback(async () => {
    if (state === 'loading') return
    setState('loading')
    try {
      const latex = await recognizeSelection(editor)
      if (latex) {
        setState('done')
        setTimeout(() => setState('idle'), 2000)
      } else {
        setState('error')
        setTimeout(() => setState('idle'), 2000)
      }
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 2000)
    }
  }, [editor, state])

  if (!show || !bounds) return null

  // Position button just below the selection box, centered
  const screenBounds = {
    x: editor.pageToScreen({ x: bounds.minX, y: bounds.maxY }).x,
    y: editor.pageToScreen({ x: bounds.minX, y: bounds.maxY }).y,
    cx: editor.pageToScreen({ x: (bounds.minX + bounds.maxX) / 2, y: bounds.maxY }).x,
  }

  return (
    <button
      className={`recognize-button recognize-button--${state}`}
      style={{
        position: 'absolute',
        left: `${screenBounds.cx}px`,
        top: `${screenBounds.y + 8}px`,
        transform: 'translateX(-50%)',
      }}
      onClick={handleRecognize}
      onPointerDown={stopEventPropagation}
      onPointerUp={stopEventPropagation}
      onTouchStart={stopEventPropagation}
      onTouchEnd={stopEventPropagation}
      disabled={state === 'loading'}
      title="Recognize handwriting"
    >
      {state === 'loading' ? '...' : state === 'done' ? '✓' : state === 'error' ? '✗' : '✎'}
    </button>
  )
}
