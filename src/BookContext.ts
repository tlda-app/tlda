import { createContext, useContext } from 'react'

export interface BookMember {
  key: string       // project name (manifest key)
  name: string      // display name (from manifest)
  format?: string
  pages: number
  basePath: string
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
