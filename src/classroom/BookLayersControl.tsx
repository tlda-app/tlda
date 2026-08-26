import type { BookLayerState, BookLayerId } from './bookLayers'
import './ClassroomWorkspace.css'

// The layers control: which layers are shown, and which one takes your marks.
//
// Skip, 02:08 EDT: "you select any number of layers to be visible and one to be
// the current write target." Two selections with different cardinalities, so two
// affordances in a row — a name you press to write there, and a checkbox for
// whether you can see it.
//
// It appears only for a reader who has more than one layer. Someone not enrolled
// has the book's layer and nothing else, so there is no choice to make and no
// control: the book is exactly what it was for them.
//
// He also said the menu becomes a move-to-layer menu when an annotation is
// selected. That is a separate commit; it is not stubbed here, because a control
// offering an action nothing performs is worse than one that does not offer it.

interface BookLayersControlProps {
  state: BookLayerState
  onVisibilityChange: (id: BookLayerId, visible: boolean) => void
  onTargetChange: (id: BookLayerId) => void
}

export function BookLayersControl({ state, onVisibilityChange, onTargetChange }: BookLayersControlProps) {
  return (
    <aside className="bookLayersControl markingLifecycle" aria-label="Layers">
      <span className="bookLayersControlTitle">Write to</span>
      {state.layers.map(layer => (
        <span key={layer.id} className="bookLayersControlRow">
          <button
            type="button"
            className="bookLayersControlName"
            aria-pressed={state.target === layer.id}
            disabled={!layer.targetable}
            onClick={() => onTargetChange(layer.id)}
          >
            {layer.label}
          </button>
          <label className="bookLayersControlEye">
            <input
              type="checkbox"
              checked={layer.visible}
              // The write target is what you are writing, so it cannot be
              // hidden. Disabled rather than absent, so the row does not change
              // shape as the target moves.
              disabled={layer.id === state.target}
              onChange={event => onVisibilityChange(layer.id, event.target.checked)}
              aria-label={`Show ${layer.label}`}
            />
          </label>
        </span>
      ))}
    </aside>
  )
}
