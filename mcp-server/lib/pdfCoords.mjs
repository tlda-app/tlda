/**
 * PDF (SVG) coordinate mapping — synctex coordinates ↔ canvas coordinates.
 *
 * dvisvgm outputs SVGs with viewBox "-72 -72 612 792". The TeX origin
 * (where synctex coordinates start) is at viewBox (0,0), but the page
 * shape covers the full viewBox starting at (-72,-72). All synctex
 * coordinates need +72pt before scaling to canvas coords.
 */
import fs from 'fs'
import path from 'path'

const _lc = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'shared', 'layout-constants.json'), 'utf8'))
export const PDF_WIDTH = _lc.PDF_WIDTH
export const PDF_HEIGHT = _lc.PDF_HEIGHT
export const PAGE_WIDTH = _lc.TARGET_WIDTH
export const PAGE_HEIGHT = PDF_HEIGHT * (PAGE_WIDTH / PDF_WIDTH)
export const PAGE_GAP = _lc.PAGE_GAP
// dvisvgm viewBox offset: TeX origin is 1 inch (72pt) from page edge
export const VIEWBOX_OFFSET = 72

export function pdfToCanvas(page, pdfX, pdfY) {
  const pageY = (page - 1) * (PAGE_HEIGHT + PAGE_GAP)
  const scaleX = PAGE_WIDTH / PDF_WIDTH
  const scaleY = PAGE_HEIGHT / PDF_HEIGHT
  return {
    x: (pdfX + VIEWBOX_OFFSET) * scaleX,
    y: pageY + (pdfY + VIEWBOX_OFFSET) * scaleY,
  }
}

export function canvasToPdf(canvasX, canvasY) {
  const page = Math.floor(canvasY / (PAGE_HEIGHT + PAGE_GAP)) + 1
  const localY = canvasY - (page - 1) * (PAGE_HEIGHT + PAGE_GAP)
  const scaleX = PAGE_WIDTH / PDF_WIDTH
  const scaleY = PAGE_HEIGHT / PDF_HEIGHT
  return {
    page,
    pdfX: canvasX / scaleX - VIEWBOX_OFFSET,
    pdfY: localY / scaleY - VIEWBOX_OFFSET,
  }
}
