import {
  Box,
} from 'tldraw'
import type { TLAssetId, TLShapeId } from 'tldraw'
import type { PageTextData } from '../TextSelectionLayer'

// Global document info for synctex anchoring
export let currentDocumentInfo: {
  name: string
  pages: Array<{ bounds: { x: number, y: number, width: number, height: number }, width: number, height: number }>
} | null = null

export function setCurrentDocumentInfo(info: typeof currentDocumentInfo) {
  currentDocumentInfo = info
}

export interface SvgPage {
  src: string
  bounds: Box
  assetId: TLAssetId
  shapeId: TLShapeId
  width: number
  height: number
  textData?: PageTextData | null
  tldrawPageId?: string  // TLDraw page ID for multipage HTML docs
  tldrawPageName?: string  // Display name for the TLDraw page
}

export interface SvgDocument {
  name: string
  pages: SvgPage[]
  macros?: Record<string, string>
  basePath?: string  // URL path prefix for files (e.g. "/docs/bregman/")
  format?: 'svg' | 'png' | 'html' | 'diff' | 'slides'
  diffLayout?: DiffLayout
}

export interface DiffHighlight {
  x: number
  y: number
  w: number
  h: number
  side: 'current' | 'old'
  currentPage: number  // which diff pair this belongs to (1-indexed)
}

export interface DiffArrow {
  startX: number; startY: number
  endX: number; endY: number
  oldHighlightIdx: number
  currentHighlightIdx: number
}

export interface DiffChange {
  currentPage: number
  oldPages: number[]
}

export interface DiffLayout {
  oldPageIndices: Set<number>
  highlights: DiffHighlight[]
  arrows: DiffArrow[]
  changes: DiffChange[]
}

export interface DiffData {
  pages: SvgPage[]
  highlights: DiffHighlight[]
  arrows: DiffArrow[]
  changes: DiffChange[]
}

// Re-export Box for convenience
export { Box }
