/**
 * PDF (SVG) coordinate mapping — synctex coordinates ↔ canvas coordinates.
 */
import fs from 'fs'
import path from 'path'

const _lc = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'shared', 'layout-constants.json'), 'utf8'))
export const PDF_WIDTH = _lc.PDF_WIDTH
export const PDF_HEIGHT = _lc.PDF_HEIGHT
export const PAGE_WIDTH = _lc.TARGET_WIDTH
export const PAGE_HEIGHT = PDF_HEIGHT * (PAGE_WIDTH / PDF_WIDTH)
export const PAGE_GAP = _lc.PAGE_GAP

export function pdfToCanvas(page, pdfX, pdfY) {
  const pageY = (page - 1) * (PAGE_HEIGHT + PAGE_GAP)
  const scaleX = PAGE_WIDTH / PDF_WIDTH
  const scaleY = PAGE_HEIGHT / PDF_HEIGHT
  return {
    x: pdfX * scaleX,
    y: pageY + pdfY * scaleY,
  }
}

export function canvasToPdf(canvasX, canvasY) {
  const page = Math.floor(canvasY / (PAGE_HEIGHT + PAGE_GAP)) + 1
  const localY = canvasY - (page - 1) * (PAGE_HEIGHT + PAGE_GAP)
  const scaleX = PAGE_WIDTH / PDF_WIDTH
  const scaleY = PAGE_HEIGHT / PDF_HEIGHT
  return {
    page,
    pdfX: canvasX / scaleX,
    pdfY: localY / scaleY,
  }
}
