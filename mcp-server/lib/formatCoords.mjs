/**
 * Format-aware coordinate dispatcher.
 * Routes to pdfCoords or htmlCoords based on document format.
 */
import { readJsonSync, readManifestSync } from '../data-source.mjs'
import { pdfToCanvas, canvasToPdf, PDF_WIDTH, PDF_HEIGHT, PAGE_WIDTH, PAGE_HEIGHT, PAGE_GAP } from './pdfCoords.mjs'
import { htmlToCanvas, canvasToHtml, loadHtmlLayout } from './htmlCoords.mjs'

export { PDF_WIDTH, PDF_HEIGHT, PAGE_WIDTH, PAGE_HEIGHT, PAGE_GAP }
export { pdfToCanvas, canvasToPdf }
export { htmlToCanvas, canvasToHtml, loadHtmlLayout }

export function isHtmlDoc(docName) {
  const lookup = readJsonSync(docName, 'lookup.json')
  if (lookup?.meta?.format === 'html') return true
  const manifest = readManifestSync()
  return manifest?.documents?.[docName]?.format === 'html'
}

export function docToCanvas(docName, page, x, y) {
  if (isHtmlDoc(docName)) {
    const result = htmlToCanvas(docName, page, x, y)
    if (result) return result
    return { x, y: (page - 1) * 432 + y }
  }
  return pdfToCanvas(page, x, y)
}

export function canvasToDoc(docName, canvasX, canvasY) {
  if (isHtmlDoc(docName)) {
    const result = canvasToHtml(docName, canvasX, canvasY)
    if (!result) return { page: 1, pdfX: canvasX, pdfY: canvasY }
    return { page: result.page, pdfX: result.localX, pdfY: result.localY }
  }
  return canvasToPdf(canvasX, canvasY)
}

export function getPageWidth(docName) {
  if (isHtmlDoc(docName)) {
    const layout = loadHtmlLayout(docName)
    return layout?.pages?.[0]?.width || 800
  }
  return PAGE_WIDTH
}
