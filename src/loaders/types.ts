import type { DeckSlide, DeckLayout } from './deckLayout'

import {
  Box,
} from 'tldraw'
import type { TLAssetId, TLShapeId } from 'tldraw'
import type { PageTextData } from '../TextSelectionLayer'

// Global document info for synctex anchoring
export let currentDocumentInfo: {
  name: string
  format?: SvgDocument['format']
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
  targetBasePath?: string  // per-page basePath for multi-target docs
  pageInTarget?: number    // 1-based page number within the target
  targetName?: string      // which target this page belongs to
  source?: {
    type?: string
    format?: string
    file?: string
  }
}

export interface SlideInfo {
  file: string
  width: number
  height: number
  title?: string
  /** The deck's address space, one entry per slide. See deckLayout.ts. */
  slides?: DeckSlide[]
  variant?: 'slides'
}

export interface TargetInfo {
  name: string
  title: string
  pages: number
  basePath: string
  /**
   * The real size of each page, in points, when the builder knows it.
   *
   * A LaTeX target does not carry this and does not need to: its pages are
   * rendered from a class that fixes the paper size, and the layout's US Letter
   * constant has always described them. A PDF is the opposite — it arrives at
   * whatever size its author chose, and `pdfinfo` reads that per page, so the
   * page box has to come from the document rather than from a constant.
   *
   * Optional on purpose. Absent means "use the constant", which is what every
   * existing caller does.
   */
  pageSizes?: { width: number; height: number }[]
}

export interface SvgDocument {
  name: string
  title?: string
  pages: SvgPage[]
  slideInfo?: SlideInfo[]
  /** Where each slide address sits, for a deck. */
  deckLayout?: DeckLayout
  macros?: Record<string, string>
  basePath?: string  // URL path prefix for files (e.g. "/docs/bregman/")
  // `pdf` is a document whose pages are SVGs rendered from a PDF rather than
  // from a LaTeX build. It matters here because it looks exactly like `svg` at
  // this layer and is not: it has no synctex, no source map and no proof data.
  format?: 'svg' | 'png' | 'html' | 'slides' | 'markdown' | 'qmd' | 'pdf'
  targets?: TargetInfo[]  // present for multi-target projects
  // Markdown parts (notes/scratch) attached to a non-html/markdown project —
  // e.g. a LaTeX project's scratch columns. Rendered as html-page shapes on
  // their own TLDraw page, separate from this document's own `pages`.
  partPages?: SvgPage[]
}

// Re-export Box for convenience
export { Box }
