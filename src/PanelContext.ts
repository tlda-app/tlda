import { createContext } from 'react'
import type { PageTextData } from './TextSelectionLayer'
import type { DiffChange, ProofPair } from './svgDocumentLoader'
import type { HistoryEntry, PageDiff, ChangeItem } from './historyStore'

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
  // Legacy localStorage snapshots (kept for compatibility)
  snapshotCount?: number
  snapshotTimestamps?: number[]
  activeSnapshotIdx?: number
  onSliderChange?: (idx: number) => void
  // Server-backed history
  historyEntries?: HistoryEntry[]
  activeHistoryIdx?: number
  historyLoading?: boolean
  historyChangedPages?: PageDiff[]
  historyChanges?: ChangeItem[]
  onHistoryChange?: (idx: number) => void
  showHistoryPanel?: boolean
  onToggleHistoryPanel?: () => void
  selectedChangeId?: string | null
  onSelectChange?: (id: string | null) => void
}

export const PanelContext = createContext<PanelContextValue | null>(null)
