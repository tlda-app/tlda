import { useState, useEffect, useRef } from 'react'
import type { BookLayerState, BookLayerId } from './bookLayers'
import './BookLayersControl.css'

// The layers control: which layers are shown, and which one takes your marks.
//
// Skip, 02:08 EDT: "you select any number of layers to be visible and one to be
// the current write target." Two selections with different cardinalities, so two
// affordances per row — press the name to write there, tick the box to see it.
//
// Skip, 02:10 EDT: "btw there shlils be layer icons in the old presentation
// mode" — and there are. `src/pills/AnnotationVisibilityPill.tsx` is a pill with
// a stacked-layers glyph and a popup, so this is a pill with a stacked-layers
// glyph and a popup. It is deliberately not that component: that one's "layers"
// are own-versus-others' annotations inside a single room at three opacities,
// which is a different thing wearing the same word. Sharing the look without
// sharing the model is the point.
//
// It appears only for a reader who has more than one layer. Someone not enrolled
// has the book's layer and nothing else, so there is no choice to make and no
// control: the book is exactly what it was for them.
//
// Skip, 02:09 EDT: "and prob on selection the layer menu becomes a move-to-layer
// menu", "like if you have selected an annotation". So it is one control with two
// readings rather than two controls:
//
//   nothing selected      where do my next marks go
//   annotation selected   move these to layer X
//
// Which is what makes his opening question answerable — "so students cant submit
// their stuff to the common layer?" Work privately on your own layer, select it,
// move it to the class's.

/** Two stacked layers, with the named one filled and the other an outline. */
function LayersIcon({ upper }: { upper: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="bookLayersIcon" aria-hidden="true">
      <rect
        x="1" y="4" width="9" height="8" rx="1"
        fill={upper ? 'none' : 'currentColor'}
        stroke="currentColor" strokeWidth="1.2" opacity={upper ? 0.7 : 0.9}
      />
      <rect
        x="4" y="1" width="9" height="8" rx="1"
        fill={upper ? 'currentColor' : 'none'}
        stroke="currentColor" strokeWidth="1.2" opacity={upper ? 0.9 : 0.7}
      />
    </svg>
  )
}

interface BookLayersControlProps {
  state: BookLayerState
  onVisibilityChange: (id: BookLayerId, visible: boolean) => void
  onTargetChange: (id: BookLayerId) => void
  /** How many annotations are selected on the write target. */
  selectionCount: number
  onMoveSelection: (id: BookLayerId) => void
  onCopySelection: (id: BookLayerId) => void
  /** Set when a move could not be completed. Nothing was lost — it is still where it was. */
  moveError?: string
}

export function BookLayersControl({
  state,
  onVisibilityChange,
  onTargetChange,
  selectionCount,
  onMoveSelection,
  onCopySelection,
  moveError,
}: BookLayersControlProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const target = state.layers.find(l => l.id === state.target)
  const moving = selectionCount > 0

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  return (
    <div className="bookLayersControl" ref={containerRef}>
      <span
        className="bookLayersBadge"
        onClick={() => setOpen(o => !o)}
        onPointerDown={event => event.stopPropagation()}
        title={moving ? `Move ${selectionCount} to a layer` : `Writing to: ${target?.label ?? ''}`}
      >
        <LayersIcon upper={state.target !== 'common'} />
        <span className="bookLayersBadgeLabel">
          {moving ? `Move ${selectionCount}` : target?.label}
        </span>
      </span>
      {open && (
        <div className="bookLayersPopup" onPointerDown={event => event.stopPropagation()}>
          {moveError && <div className="bookLayersError">{moveError}</div>}
          {state.layers.map(layer => {
            // Moving offers the layers you may write, except the one the
            // selection is already on. Writing offers the layers you may write.
            const isSource = layer.id === state.target
            const disabled = !layer.targetable || (moving && isSource)
            return (
              <div key={layer.id} className={`bookLayersOption${!moving && isSource ? ' active' : ''}`}>
                <button
                  type="button"
                  className="bookLayersOptionName"
                  disabled={disabled}
                  aria-pressed={!moving && isSource}
                  onClick={() => {
                    if (moving) onMoveSelection(layer.id)
                    else onTargetChange(layer.id)
                    setOpen(false)
                  }}
                  title={
                    moving
                      ? (isSource ? `Already on ${layer.label}` : `Move to ${layer.label}`)
                      : (layer.targetable ? `Write to ${layer.label}` : `${layer.label} is not yours to write`)
                  }
                >
                  <LayersIcon upper={layer.id !== 'common'} />
                  <span>{layer.label}</span>
                </button>
                {/* Skip: "we can expose, like, move and copy." Two operations on
                    one destination, so the destination is the row and the verb is
                    the button — rather than a mode you set first and then forget
                    you are in. His follow-on, "or will move always be a copy?",
                    is unanswered, so both are offered and neither is assumed. */}
                {moving && (
                  <button
                    type="button"
                    className="bookLayersOptionCopy"
                    disabled={disabled}
                    onClick={() => { onCopySelection(layer.id); setOpen(false) }}
                    title={`Copy to ${layer.label}, leaving the originals here`}
                  >
                    Copy
                  </button>
                )}
                <label className="bookLayersOptionEye" title={`Show ${layer.label}`}>
                  <input
                    type="checkbox"
                    checked={layer.visible}
                    // The write target is what you are writing, so it cannot be
                    // hidden. Disabled rather than absent, so the row does not
                    // change shape as the target moves.
                    disabled={layer.id === state.target}
                    onChange={event => onVisibilityChange(layer.id, event.target.checked)}
                    aria-label={`Show ${layer.label}`}
                  />
                </label>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
