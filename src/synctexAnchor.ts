// SyncTeX anchoring for annotations
// Stores source locations so annotations can survive document rebuilds

const SYNCTEX_SERVER = import.meta.env.VITE_SYNCTEX_SERVER || 'http://localhost:5177'

export interface SourceAnchor {
  file: string    // Source file (relative to doc root)
  line: number    // Line number
  column?: number // Column number
}

export interface PdfPosition {
  page: number    // 1-indexed page
  x: number       // X in PDF points
  y: number       // Y in PDF points
}

/**
 * Look up source location for a PDF position
 */
export async function getSourceAnchor(
  docName: string,
  page: number,
  x: number,
  y: number
): Promise<SourceAnchor | null> {
  try {
    const url = `${SYNCTEX_SERVER}/edit?doc=${docName}&page=${page}&x=${x}&y=${y}`
    const resp = await fetch(url)
    const data = await resp.json()
    if (data.error) {
      console.warn('[SyncTeX] Anchor lookup failed:', data.error)
      return null
    }
    return { file: data.file, line: data.line, column: data.column }
  } catch (e) {
    console.warn('[SyncTeX] Server not available')
    return null
  }
}

/**
 * Look up PDF position for a source location
 */
export async function resolvAnchor(
  docName: string,
  anchor: SourceAnchor
): Promise<PdfPosition | null> {
  try {
    const url = `${SYNCTEX_SERVER}/view?doc=${docName}&file=${anchor.file}&line=${anchor.line}&column=${anchor.column || 0}`
    const resp = await fetch(url)
    const data = await resp.json()
    if (data.error) {
      console.warn('[SyncTeX] Resolve failed:', data.error)
      return null
    }
    return { page: data.page, x: data.x, y: data.y }
  } catch (e) {
    console.warn('[SyncTeX] Server not available')
    return null
  }
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
      // Convert to page-local coordinates
      const localX = canvasX - bounds.x
      const localY = canvasY - bounds.y

      // Scale from canvas units to PDF points (assuming 800px target width)
      // PDF points are 72 per inch, typical page is 612x792 points (letter)
      const scale = page.width / 800  // Original width / display width
      const pdfX = localX * scale
      const pdfY = localY * scale

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

  // Scale from PDF points to canvas units
  const scale = 800 / page.width
  const canvasX = bounds.x + pdfX * scale
  const canvasY = bounds.y + pdfY * scale

  return { x: canvasX, y: canvasY }
}
