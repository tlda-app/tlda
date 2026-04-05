/**
 * Transcription hover toast: shows LaTeX transcription when hovering
 * a recognized draw shape. Fades when pointer leaves.
 */

import type { Editor, TLShape } from 'tldraw'

let activeToast: HTMLDivElement | null = null

/** Show transcription toast near a shape. Returns cleanup function. */
export function showTranscriptionToast(editor: Editor, shape: TLShape): () => void {
  const meta = shape.meta as any
  const text = meta?.transcription
  if (!text) return () => {}

  // Remove any existing toast
  if (activeToast) { activeToast.remove(); activeToast = null }

  const bounds = editor.getShapePageBounds(shape.id)
  if (!bounds) return () => {}

  const screenPos = editor.pageToScreen({ x: bounds.maxX, y: bounds.minY })

  const toast = document.createElement('div')
  toast.className = 'transcription-toast'
  const verified = meta.transcriptionVerified
  toast.innerHTML = `<span class="transcription-toast-prefix">${verified ? '✓' : '✎'}</span> <code>${escapeHtml(text)}</code>`
  if (!verified) toast.classList.add('transcription-toast--unverified')

  Object.assign(toast.style, {
    position: 'fixed',
    left: `${Math.min(screenPos.x + 8, window.innerWidth - 320)}px`,
    top: `${Math.max(screenPos.y - 8, 8)}px`,
    maxWidth: '300px',
    padding: '6px 10px',
    background: 'rgba(0, 0, 0, 0.85)',
    color: '#fff',
    fontSize: '12px',
    lineHeight: '1.4',
    borderRadius: '6px',
    zIndex: '99999',
    pointerEvents: 'none',
    fontFamily: 'system-ui, sans-serif',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    opacity: '1',
    transition: 'opacity 0.3s ease-out',
  })

  document.body.appendChild(toast)
  activeToast = toast

  return () => {
    toast.style.opacity = '0'
    setTimeout(() => {
      toast.remove()
      if (activeToast === toast) activeToast = null
    }, 300)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
