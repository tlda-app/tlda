import { createContext } from 'react'
import type { PageTextData } from './TextSelectionLayer'
import type { DiffChange } from './svgDocumentLoader'

export interface PanelContextValue {
  docName: string
  pages: Array<{ bounds: { x: number; y: number; width: number; height: number }; width: number; height: number; textData?: PageTextData | null }>
  diffChanges?: DiffChange[]
  onFocusChange?: (currentPage: number) => void
  diffAvailable?: boolean
  diffMode?: boolean
  onToggleDiff?: () => void
  diffLoading?: boolean
}

export const PanelContext = createContext<PanelContextValue | null>(null)
