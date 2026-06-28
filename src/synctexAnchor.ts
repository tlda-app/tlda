// SyncTeX anchoring for annotations
// Stores source locations so annotations can survive document rebuilds
// Uses server when available (local dev), falls back to static lookup.json (hosted)
declare const USE_SERVER: boolean
declare const SYNCTEX_SERVER: string

import {
  getSourceAnchorStatic,
  resolveAnchorStatic,
  type LookupData,
  type LookupEntry,
} from './synctexLookup'
import { PDF_WIDTH, PDF_HEIGHT } from './layoutConstants'

// dvisvgm SVG viewBox is "-72 -72 612 792". Synctex coords have origin at the
// TeX reference point (1 inch from page edges), which is viewBox (0,0). The page
// shape covers the full viewBox, so synctex coords need +72 before scaling.
export const SYNCTEX_VIEWBOX_OFFSET = 72
export const SYNCTEX_MAX_Y = PDF_HEIGHT - SYNCTEX_VIEWBOX_OFFSET

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

export interface SourceLineLookupEntry extends PdfPosition {
  file: string
  line: number
  content?: string
  dist: number
}

export interface CanvasPdfPosition extends PdfPosition {
  canvasX: number
  canvasY: number
  pageBounds: { x: number; y: number; width: number; height: number }
  scaleX: number
  scaleY: number
}

function boundsValue(bounds: any, key: 'x' | 'y' | 'w' | 'h') {
  if (!bounds) return 0
  if (key === 'x') return Number(bounds.x ?? bounds.minX ?? 0)
  if (key === 'y') return Number(bounds.y ?? bounds.minY ?? 0)
  if (key === 'w') return Number(bounds.w ?? bounds.width ?? 0)
  return Number(bounds.h ?? bounds.height ?? 0)
}

export function normalizeSynctexFile(file: string, fallback = 'main.tex') {
  return file.replace(/^\.\//, '') || fallback
}

export function parseLookupLineKey(key: string, lookup: LookupData) {
  const colonIdx = key.indexOf(':')
  if (colonIdx >= 0) {
    return {
      file: normalizeSynctexFile(key.slice(0, colonIdx)),
      line: Number.parseInt(key.slice(colonIdx + 1), 10),
    }
  }
  return {
    file: normalizeSynctexFile(lookup.meta?.texFile || 'main.tex'),
    line: Number.parseInt(key, 10),
  }
}

export function isUsableLookupEntry(entry: Pick<LookupEntry, 'y'> | null | undefined) {
  return !!entry && entry.y >= 0 && entry.y <= SYNCTEX_MAX_Y
}

export function lookupSourceLine(
  lookup: LookupData | null,
  file: string,
  line: number,
): SourceLineLookupEntry | null {
  if (!lookup) return null
  const wantedFile = normalizeSynctexFile(file)
  const wantedLine = Math.max(1, Math.floor(line || 1))
  let best: SourceLineLookupEntry | null = null
  for (const [key, entry] of Object.entries(lookup.lines || {})) {
    if (!isUsableLookupEntry(entry)) continue
    const parsed = parseLookupLineKey(key, lookup)
    if (!Number.isFinite(parsed.line) || parsed.file !== wantedFile) continue
    const dist = Math.abs(parsed.line - wantedLine)
    if (!best || dist < best.dist) {
      best = {
        file: parsed.file,
        line: parsed.line,
        page: entry.page,
        x: entry.x,
        y: entry.y,
        content: entry.content,
        dist,
      }
    }
  }
  return best
}

export function pdfToEditorCanvas(
  editor: any,
  pdfPage: number,
  pdfX: number,
  pdfY: number,
): CanvasPdfPosition | null {
  if (!editor) return null
  const pageShape = (editor.getCurrentPageShapes?.() || [])
    .find((s: any) => s?.type === 'svg-page' && s?.props?.pageIndex === pdfPage - 1)
  if (!pageShape) return null
  const pageShapeBounds = editor.getShapePageBounds?.(pageShape.id)
  const x = boundsValue(pageShapeBounds, 'x')
  const y = boundsValue(pageShapeBounds, 'y')
  const width = boundsValue(pageShapeBounds, 'w')
  const height = boundsValue(pageShapeBounds, 'h')
  if (!width || !height) return null
  const scaleX = width / PDF_WIDTH
  const scaleY = height / PDF_HEIGHT
  return {
    page: pdfPage,
    x: pdfX,
    y: pdfY,
    canvasX: x + (pdfX + SYNCTEX_VIEWBOX_OFFSET) * scaleX,
    canvasY: y + (pdfY + SYNCTEX_VIEWBOX_OFFSET) * scaleY,
    pageBounds: { x, y, width, height },
    scaleX,
    scaleY,
  }
}

export function sourceLineToEditorCanvas(
  editor: any,
  lookup: LookupData | null,
  file: string,
  line: number,
): (SourceLineLookupEntry & CanvasPdfPosition) | null {
  const entry = lookupSourceLine(lookup, file, line)
  if (!entry) return null
  const canvas = pdfToEditorCanvas(editor, entry.page, entry.x, entry.y)
  return canvas ? { ...entry, ...canvas } : null
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
  // Static lookup — uses lookup.json generated at build time
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
      // The viewBox starts at -72, so canvas origin maps to viewBox -72.
      // Subtract VIEWBOX_OFFSET to convert from viewBox coords to synctex coords.
      const scaleX = bounds.width / PDF_WIDTH   // pixels per viewBox unit
      const scaleY = bounds.height / PDF_HEIGHT
      const pdfX = localX / scaleX - SYNCTEX_VIEWBOX_OFFSET
      const pdfY = localY / scaleY - SYNCTEX_VIEWBOX_OFFSET

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
  // Synctex coords start at TeX origin (72pt from page edge = viewBox 0,0).
  // Add SYNCTEX_VIEWBOX_OFFSET to shift from synctex space to viewBox space before scaling.
  const scaleX = bounds.width / PDF_WIDTH
  const scaleY = bounds.height / PDF_HEIGHT

  const canvasX = bounds.x + (pdfX + SYNCTEX_VIEWBOX_OFFSET) * scaleX
  const canvasY = bounds.y + (pdfY + SYNCTEX_VIEWBOX_OFFSET) * scaleY

  return { x: canvasX, y: canvasY }
}
