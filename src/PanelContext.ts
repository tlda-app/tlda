import { createContext } from 'react'
import type { PageTextData } from './TextSelectionLayer'
import type { DiffChange, ProofPair } from './svgDocumentLoader'

export interface PanelContextValue {
  docName: string
  pages: Array<{ bounds: { x: number; y: number; width: number; height: number }; width: number; height: number; textData?: PageTextData | null; shapeId?: string }>
  diffChanges?: DiffChange[]
  onFocusChange?: (currentPage: number) => void
  diffAvailable?: boolean
  diffMode?: boolean
  onToggleDiff?: () => void
  diffLoading?: boolean
  proofPairs?: ProofPair[]
  proofMode?: boolean
  onToggleProof?: () => void
  proofLoading?: boolean
  cameraLinked?: boolean
  onToggleCameraLink?: () => void
  panelsLocal?: boolean
  onTogglePanelsLocal?: () => void
  snapshotCount?: number
  snapshotTimestamps?: number[]
  activeSnapshotIdx?: number
  onSliderChange?: (idx: number) => void
}

export const PanelContext = createContext<PanelContextValue | null>(null)
