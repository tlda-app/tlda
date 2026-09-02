import { createContext, useContext } from 'react'
import type { BookLayerState, BookLayerId } from './classroom/bookLayers'

export interface BookMember {
  key: string       // project name (manifest key)
  name: string      // display name (from manifest)
  format?: string
  // Set by the qmd builder only. A member is viewed by viewFormat(member), the
  // same question App.tsx asks of a standalone document — a deck reaches the
  // book either as format 'slides' or as a qmd that rendered to one, and
  // `format` alone cannot tell those apart from an ordinary qmd chapter.
  renderedFormat?: 'html' | 'slides'
  pages: number
  basePath: string
  sessionAt?: number  // timestamp of last push with session tag (for hot session)
}

/**
 * The reader's layers, and the two selections over them, passed to whichever
 * surface is drawing the chrome.
 *
 * It travels through the context rather than being rendered where the state
 * lives because the control belongs with the ordinary controls, and the surface
 * that owns those is the document editor — including when that editor is
 * presenting. Mounting it beside the state instead is what confined it to the
 * book's own top-left corner and kept it off the presentation surface entirely.
 */
export interface BookLayersValue {
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

export interface BookContextValue {
  bookName: string
  members: BookMember[]
  activeIndex: number
  switchTo: (index: number, variant?: 'slides') => void
  layers?: BookLayersValue
}

export const BookContext = createContext<BookContextValue | null>(null)

export function useBook() {
  return useContext(BookContext)
}
