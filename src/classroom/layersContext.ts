import { createContext, useContext } from 'react'
import type { BookLayerState, BookLayerId } from './bookLayers'

/**
 * The reader's layers, and the two selections over them, passed to whichever
 * surface is drawing the chrome.
 *
 * This used to hang off `BookContext`, which meant the layers control could only
 * appear where there was a book. Skip presents and reads ordinary documents and
 * decks, and those are rendered without one — so on the surface he was looking
 * at, the control rendered nothing and the only thing left in that row was draft
 * mode. Layers are not a property of books; they are a property of a reader
 * looking at a document, so they get their own context and a book is just one of
 * the surfaces that can supply it.
 */
export interface LayersValue {
  state: BookLayerState
  setVisible: (id: BookLayerId, visible: boolean) => void
  setTarget: (id: BookLayerId) => void
  /** How many annotations are selected on the write target. */
  selectionCount: number
  moveSelection: (id: BookLayerId) => void
  /** Skip named two operations: "we can expose, like, move and copy." */
  copySelection: (id: BookLayerId) => void
  /** Set when a move or copy could not be completed. Nothing was lost. */
  moveError?: string
}

export const LayersContext = createContext<LayersValue | null>(null)

export function useLayers() {
  return useContext(LayersContext)
}
