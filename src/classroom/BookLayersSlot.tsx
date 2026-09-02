import { useLayers } from './layersContext'
import { BookLayersControl } from './BookLayersControl'

// The layer control, where the ordinary controls are.
//
// Skip, 2026-08-27: "where was the layer selector?" — presenting a deck, it was
// nowhere it could be. It was mounted inside BookViewer, fixed to the top-left
// corner, and rendered only for `identity?.role === 'student'`, so an instructor
// never had it on any surface and nobody had it on the presentation surface.
//
// Two of those three were conditions on the reader rather than on the layers.
// The rule is the one BookLayersControl's own header states: it appears for a
// reader who has more than one layer, because one layer is no choice to make.
// That is a question about the layer set, and it is the same question for a
// student, an instructor reading a student's work, and anyone else.
//
// The third was placement. It sits in the pills row with the rest, so it is on
// whatever surface the document is on — presentation included — and it moves
// when they move.
export function BookLayersSlot() {
  const layers = useLayers()
  // No layers on this surface, or one layer: nothing to choose between, so no
  // control. Not a gate on who is reading — there is no such gate anywhere on
  // this path now, and no longer a gate on being in a book either.
  if (!layers || layers.state.layers.length < 2) return null
  return (
    <BookLayersControl
      state={layers.state}
      onVisibilityChange={layers.setVisible}
      onTargetChange={layers.setTarget}
      selectionCount={layers.selectionCount}
      onMoveSelection={layers.moveSelection}
      onCopySelection={layers.copySelection}
      moveError={layers.moveError}
    />
  )
}
