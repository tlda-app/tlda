import {
  Box,
  AssetRecordType,
  createShapeId,
} from 'tldraw'
import { PAGE_GAP } from '../layoutConstants'
import type { SvgPage, SvgDocument } from './types'

export interface SlidePageEntry {
  file: string
  width: number
  height: number
  title?: string
  slideIndex: number
}

/**
 * Load a slides document (Quarto reveal.js deck).
 * All slides on a single TLDraw page, stacked vertically like SVG pages.
 * Each slide is an HtmlPageShape iframe loading the same HTML file at a different slide index.
 */
export async function loadSlidesDocument(
  name: string,
  basePath: string,
): Promise<SvgDocument> {
  console.log(`Loading slides document from ${basePath}`)

  const infoUrl = basePath + 'page-info.json'
  const pageInfos: SlidePageEntry[] = await fetch(infoUrl).then(r => r.json())

  console.log(`Found ${pageInfos.length} slides`)

  const gap = PAGE_GAP
  let top = 0
  const pages: SvgPage[] = pageInfos.map((info, i) => {
    const pageId = `${name}-slide-${i}`
    // Build URL with slide index query param
    const url = basePath + info.file + `?_ctdSlide=${info.slideIndex}`
    const page: SvgPage = {
      src: url,
      bounds: new Box(0, top, info.width, info.height),
      assetId: AssetRecordType.createId(pageId),
      shapeId: createShapeId(pageId),
      width: info.width,
      height: info.height,
    }
    top += info.height + gap
    return page
  })

  console.log(`Slides document ready (${pageInfos.length} slides)`)
  return { name, pages, basePath, format: 'slides' }
}
