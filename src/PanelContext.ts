import { createContext } from 'react'
import type { PageTextData } from './TextSelectionLayer'

export interface PanelContextValue {
  docName: string
  pages: Array<{ bounds: { x: number; y: number; width: number; height: number }; width: number; height: number; textData?: PageTextData | null }>
}

export const PanelContext = createContext<PanelContextValue | null>(null)
