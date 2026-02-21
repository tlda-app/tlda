import { createContext, type ReactNode } from 'react'
import type { PageTextData } from './TextSelectionLayer'
import type { DiffChange, ProofPair } from './svgDocumentLoader'
import type { HistoryEntry, PageDiff, ChangeItem } from './historyStore'
import type { BuildError, BuildWarning } from './useYjsSync'

/** Stable document info — set once per document load, never changes during session. */
export interface DocContextValue {
  docName: string
  pages: Array<{ bounds: { x: number; y: number; width: number; height: number }; width: number; height: number; textData?: PageTextData | null; shapeId?: string }>
}

/** Volatile panel state — toggles, loading flags, history slider, etc. */
export interface PanelContextValue {
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
  buildErrors?: BuildError[]
  buildWarnings?: BuildWarning[]
}

export const DocContext = createContext<DocContextValue | null>(null)
export const PanelContext = createContext<PanelContextValue | null>(null)

/** Bottom-left panels + agent pill — rendered inside InFrontOfTheCanvas for TLDraw event handling */
export const BottomPanelsContext = createContext<ReactNode>(null)
export const AgentPillContext = createContext<ReactNode>(null)
