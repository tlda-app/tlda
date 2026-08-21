import { createContext, useContext } from 'react'
import type { DocumentViewManifest } from './loaders/documentLoaderRegistry'

export interface BookMember {
  key: string       // project name (manifest key)
  name: string      // display name (from manifest)
  documentManifest?: DocumentViewManifest
  pages: number
  basePath: string
  sessionAt?: number  // timestamp of last push with session tag (for hot session)
}

export interface BookContextValue {
  bookName: string
  members: BookMember[]
  activeIndex: number
  switchTo: (index: number) => void
}

export const BookContext = createContext<BookContextValue | null>(null)

export function useBook() {
  return useContext(BookContext)
}
