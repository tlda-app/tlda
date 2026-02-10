// SyncTeX anchoring for annotations
// Stores source locations so annotations can survive document rebuilds
// Uses server when available (local dev), falls back to static lookup.json (hosted)

import {
  getSourceAnchorStatic,
  resolveAnchorStatic
} from './synctexLookup'

const SYNCTEX_SERVER = import.meta.env.VITE_SYNCTEX_SERVER || 'http://localhost:5177'

// On HTTPS pages, skip server (browser blocks mixed content http://localhost from https://)
const USE_SERVER = typeof window === 'undefined' || window.location.protocol !== 'https:'

// Standard PDF page dimensions in points (US Letter)
const PDF_WIDTH = 612
const PDF_HEIGHT = 792

// Note: synctex y coords are measured from page top (0 = top of physical page).
// The SVG viewBox starts at -72, but the page image shape maps the full viewBox
// to canvas pixels, so canvas_y = page.y + synctex_y * scale (no offset needed).

export interface SourceAnchor {
  file: string      // Source file (relative to doc root)
  line: number      // Line number (may become stale after edits)
  column?: number   // Column number
  content?: string  // Content fingerprint for robust matching
}

export interface PdfPosition {
  page: number    // 1-indexed page
  x: number       // X in PDF points
  y: number       // Y in PDF points
}

/**
 * Look up source location for a PDF position
 * Tries server first (local dev), falls back to static lookup (hosted)
 */
export async function getSourceAnchor(
  docName: string,
  page: number,
  x: number,
  y: number
): Promise<SourceAnchor | null> {
  // Try server first (only on HTTP, not HTTPS)
  if (USE_SERVER) try {
    const url = `${SYNCTEX_SERVER}/edit?doc=${docName}&page=${page}&x=${x}&y=${y}`
    const resp = await fetch(url, { signal: AbortSignal.timeout(2000) })
    const data = await resp.json()
    if (!data.error) {
      const anchor: SourceAnchor = { file: data.file, line: data.line, column: data.column }

      // Fetch content fingerprint for this line
      try {
        const contentUrl = `${SYNCTEX_SERVER}/content?doc=${encodeURIComponent(docName)}&file=${encodeURIComponent(data.file)}&line=${data.line}`
        const contentResp = await fetch(contentUrl)
        const contentData = await contentResp.json()
        if (contentData.content) {
          const trimmed = contentData.content.trim()
          if (trimmed.length > 0) {
            anchor.content = trimmed.slice(0, 80)
          }
        }
      } catch {
        // Content fingerprint is optional
      }

      return anchor
    }
  } catch {
    // Server not available, try static
  }

  // Fall back to static lookup
  console.log('[SyncTeX] Using static lookup')
  return getSourceAnchorStatic(docName, page, x, y)
}

/**
 * Look up PDF position for a source location
 * Tries server first (local dev), falls back to static lookup (hosted)
 */
export async function resolvAnchor(
  docName: string,
  anchor: SourceAnchor
): Promise<PdfPosition | null> {
  // Try server first (only on HTTP, not HTTPS)
  if (USE_SERVER) try {
    let resolvedLine = anchor.line

    // If we have a content fingerprint, try to find the current line
    if (anchor.content) {
      const findUrl = `${SYNCTEX_SERVER}/find?doc=${encodeURIComponent(docName)}&file=${encodeURIComponent(anchor.file)}&content=${encodeURIComponent(anchor.content)}&hint=${anchor.line}`
      const findResp = await fetch(findUrl, { signal: AbortSignal.timeout(2000) })
      const findData = await findResp.json()

      if (findData.matches && findData.matches.length > 0) {
        const bestMatch = findData.matches[0]
        if (bestMatch.line !== anchor.line) {
          console.log(`[SyncTeX] Content found at line ${bestMatch.line} (was ${anchor.line})`)
        }
        resolvedLine = bestMatch.line
      }
    }

    const url = `${SYNCTEX_SERVER}/view?doc=${encodeURIComponent(docName)}&file=${encodeURIComponent(anchor.file)}&line=${resolvedLine}&column=${anchor.column || 0}`
    const resp = await fetch(url, { signal: AbortSignal.timeout(2000) })
    const data = await resp.json()
    if (!data.error) {
      return { page: data.page, x: data.x, y: data.y }
    }
  } catch {
    // Server not available, try static
  }

  // Fall back to static lookup
  console.log('[SyncTeX] Using static lookup for resolve')
  return resolveAnchorStatic(docName, anchor)
}

/**
 * Convert canvas coordinates to PDF coordinates
 * This depends on how the SVG pages are laid out
 */
export function canvasToPdf(
  canvasX: number,
  canvasY: number,
  pages: Array<{ bounds: { x: number, y: number, width: number, height: number }, width: number, height: number }>
): { page: number, x: number, y: number } | null {
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const bounds = page.bounds

    // Check if point is within this page
    if (canvasY >= bounds.y && canvasY < bounds.y + bounds.height) {
      // Convert to page-local coordinates (pixels from page corner)
      const localX = canvasX - bounds.x
      const localY = canvasY - bounds.y

      // Scale from canvas pixels to synctex/PDF units
      // Synctex y coords are from page top (0 = top of page)
      // Canvas local coords already start at page top, so just divide by scale
      const scaleX = bounds.width / PDF_WIDTH   // pixels per viewBox unit
      const scaleY = bounds.height / PDF_HEIGHT
      const pdfX = localX / scaleX
      const pdfY = localY / scaleY

      return { page: i + 1, x: pdfX, y: pdfY }
    }
  }
  return null
}

/**
 * Convert PDF coordinates back to canvas coordinates
 */
export function pdfToCanvas(
  pdfPage: number,
  pdfX: number,
  pdfY: number,
  pages: Array<{ bounds: { x: number, y: number, width: number, height: number }, width: number, height: number }>
): { x: number, y: number } | null {
  const pageIndex = pdfPage - 1
  if (pageIndex < 0 || pageIndex >= pages.length) return null

  const page = pages[pageIndex]
  const bounds = page.bounds

  // Scale from synctex coords to canvas pixels
  // Synctex y coords are from page top (0 = top of page), same as canvas local coords
  const scaleX = bounds.width / PDF_WIDTH
  const scaleY = bounds.height / PDF_HEIGHT

  const canvasX = bounds.x + pdfX * scaleX
  const canvasY = bounds.y + pdfY * scaleY

  return { x: canvasX, y: canvasY }
}
