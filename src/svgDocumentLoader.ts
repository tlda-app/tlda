/**
 * Barrel re-export — all loader functionality lives in src/loaders/.
 * This file exists so existing imports don't need to change.
 */

// Types
export type {
  SvgPage,
  SvgDocument,
  DiffHighlight,
  DiffArrow,
  DiffChange,
  DiffLayout,
  DiffData,
} from './loaders/types'
export { currentDocumentInfo, setCurrentDocumentInfo } from './loaders/types'

// SVG loader (includes diff)
export {
  pageSpacing,
  createSvgDocumentLayout,
  loadSvgDocument,
  loadDiffData,
  loadDiffDocument,
} from './loaders/svgLoader'

// HTML loader
export { loadHtmlDocument } from './loaders/htmlLoader'
export type { HtmlPageEntry } from './loaders/htmlLoader'

// Slides loader (Quarto reveal.js decks)
export { loadSlidesDocument } from './loaders/slidesLoader'

// Image loader (vestigial PNG format)
export { loadImageDocument } from './loaders/imageLoader'

// Proof loader
export {
  loadProofData,
} from './loaders/proofLoader'
export type {
  ProofHighlight,
  ProofDependency,
  ProofPair,
  StatementRegion,
  LabelRegion,
  ProofData,
} from './loaders/proofLoader'
