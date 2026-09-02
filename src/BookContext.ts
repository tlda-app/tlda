import { createContext, useContext } from 'react'
import type { OfflineProgress } from './airplaneMode'

export type AirplaneState = 'off' | 'loading' | 'ready' | 'error'

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

export interface BookContextValue {
  bookName: string
  members: BookMember[]
  activeIndex: number
  switchTo: (index: number, variant?: 'slides') => void
  airplaneState: AirplaneState
  airplaneProgress: OfflineProgress
  airplaneError: string
  toggleAirplaneMode: () => void
}

export const BookContext = createContext<BookContextValue | null>(null)

export function useBook() {
  return useContext(BookContext)
}
