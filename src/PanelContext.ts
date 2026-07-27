import { createContext, type ReactNode } from 'react'
import type { PageTextData } from './TextSelectionLayer'
import type { DiffChange, ProofPair } from './svgDocumentLoader'
import type { BuildError, BuildWarning } from './useYjsSync'

/** Stable project info — set once per project load, never changes during session. */
export interface ProjectContextValue {
  projectName: string
  format?: 'svg' | 'png' | 'html' | 'diff' | 'slides' | 'markdown'
  pages: Array<{ bounds: { x: number; y: number; width: number; height: number }; width: number; height: number; textData?: PageTextData | null; shapeId?: string; tldrawPageId?: string }>
  targets?: Array<{ name: string; title: string; pages: number }>
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
  role?: 'presenter' | 'viewer'
  onToggleRole?: () => void
  panelsLocal?: boolean
  onTogglePanelsLocal?: () => void
  buildErrors?: BuildError[]
  buildWarnings?: BuildWarning[]
  // Spatial timeline overlay
  timelineActive?: boolean
  onToggleTimeline?: () => void
  // Shadow history scrubber
  shadowHistoryVisible?: boolean
  onToggleShadowHistory?: () => void
  // Currently displayed shadow version (null = showing the current project).
  // Used to stamp outgoing chats with the project version the user is viewing.
  shadowActiveVersion?: { hash: string; timestamp: number } | null
}

export const ProjectContext = createContext<ProjectContextValue | null>(null)
export const PanelContext = createContext<PanelContextValue | null>(null)

/** Bottom-left panels + agent pill — rendered inside InFrontOfTheCanvas for TLDraw event handling */
export const BottomPanelsContext = createContext<ReactNode>(null)
export const AgentPillContext = createContext<ReactNode>(null)
