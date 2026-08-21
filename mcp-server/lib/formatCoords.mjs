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

export function isHtmlDoc(projectName) {
  const lookup = readJsonSync(projectName, 'lookup.json')
  if (lookup?.meta?.format === 'html') return true
  const manifest = readManifestSync()
  return manifest?.documents?.[projectName]?.format === 'html'
}

function nativePdfPages(projectName) {
  const manifest = readJsonSync(projectName, 'document-manifest.json')
  return manifest?.source?.format === 'pdf' && Array.isArray(manifest.pages) ? manifest.pages : null
}

function nativePdfToCanvas(pages, page, x, y) {
  const index = Math.max(0, Math.min(pages.length - 1, Number(page) - 1))
  const scale = PAGE_WIDTH / Number(pages[index].width)
  const pageY = pages.slice(0, index).reduce((sum, item) => sum + Number(item.height) * (PAGE_WIDTH / Number(item.width)) + PAGE_GAP, 0)
  return { x: Number(x) * scale, y: pageY + Number(y) * scale }
}

function canvasToNativePdf(pages, canvasX, canvasY) {
  let pageY = 0
  for (let index = 0; index < pages.length; index++) {
    const scale = PAGE_WIDTH / Number(pages[index].width)
    const height = Number(pages[index].height) * scale
    if (canvasY < pageY + height + PAGE_GAP || index === pages.length - 1) {
      return { page: index + 1, pdfX: canvasX / scale, pdfY: (canvasY - pageY) / scale }
    }
    pageY += height + PAGE_GAP
  }
  return { page: 1, pdfX: canvasX, pdfY: canvasY }
}

export function docToCanvas(projectName, page, x, y) {
  const pdfPages = nativePdfPages(projectName)
  if (pdfPages?.length) return nativePdfToCanvas(pdfPages, page, x, y)
  if (isHtmlDoc(projectName)) {
    const result = htmlToCanvas(projectName, page, x, y)
    if (result) return result
    return { x, y: (page - 1) * 432 + y }
  }
  return pdfToCanvas(page, x, y)
}

export function canvasToDoc(projectName, canvasX, canvasY) {
  const pdfPages = nativePdfPages(projectName)
  if (pdfPages?.length) return canvasToNativePdf(pdfPages, canvasX, canvasY)
  if (isHtmlDoc(projectName)) {
    const result = canvasToHtml(projectName, canvasX, canvasY)
    if (!result) return { page: 1, pdfX: canvasX, pdfY: canvasY }
    return { page: result.page, pdfX: result.localX, pdfY: result.localY }
  }
  return canvasToPdf(canvasX, canvasY)
}

export function getPageWidth(projectName) {
  const pdfPages = nativePdfPages(projectName)
  if (pdfPages?.length) return PAGE_WIDTH
  if (isHtmlDoc(projectName)) {
    const layout = loadHtmlLayout(projectName)
    return layout?.pages?.[0]?.width || 800
  }
  return PAGE_WIDTH
}
