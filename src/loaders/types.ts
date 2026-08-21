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
  slideIndex: number
  indexh?: number
  indexv?: number
}

export interface TargetInfo {
  name: string
  title: string
  pages: number
  basePath: string
}

export interface SvgDocument {
  name: string
  title?: string
  pages: SvgPage[]
  slideInfo?: SlideInfo[]
  macros?: Record<string, string>
  basePath?: string  // URL path prefix for files (e.g. "/docs/bregman/")
  format?: 'svg' | 'png' | 'html' | 'slides' | 'markdown' | 'qmd'
  targets?: TargetInfo[]  // present for multi-target projects
  // Markdown parts (notes/scratch) attached to a non-html/markdown project —
  // e.g. a LaTeX project's scratch columns. Rendered as html-page shapes on
  // their own TLDraw page, separate from this document's own `pages`.
  partPages?: SvgPage[]
}

// Re-export Box for convenience
export { Box }
