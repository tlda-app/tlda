import {
  Box,
  AssetRecordType,
  createShapeId,
} from 'tldraw'
import type { SvgPage, SvgDocument } from './types'

export interface SlidePageEntry {
  file: string
  width: number
  height: number
  title?: string
  slideIndex: number
  indexh?: number
  indexv?: number
}

/** Gap between slides on the spatial canvas (px) */
export const SLIDE_GAP = 120

/**
 * Load a slides document (Quarto reveal.js deck).
 * All slides laid out left-to-right on a SINGLE TLDraw canvas.
 * Camera navigation moves between slides; fragments advance within each slide.
 */
export async function loadSlidesDocument(
  name: string,
  basePath: string,
): Promise<SvgDocument> {
  console.log(`Loading slides document from ${basePath}`)

  const infoUrl = basePath + 'page-info.json'
  const pageInfos: SlidePageEntry[] = await fetch(infoUrl).then(r => r.json())

  console.log(`Found ${pageInfos.length} slides`)

  const pages: SvgPage[] = pageInfos.map((info, i) => {
    const pageId = `${name}-slide-${i}`
    const h = info.indexh ?? info.slideIndex
    const v = info.indexv ?? 0
    const url = basePath + info.file + `?_tldaH=${h}&_tldaV=${v}`
    // Horizontal layout: each slide offset by (width + gap) * index
    const x = i * (info.width + SLIDE_GAP)
    return {
      src: url,
      bounds: new Box(x, 0, info.width, info.height),
      assetId: AssetRecordType.createId(pageId),
      shapeId: createShapeId(pageId),
      width: info.width,
      height: info.height,
    }
  })

  console.log(`Slides document ready (${pageInfos.length} slides, spatial canvas)`)
  return { name, pages, basePath, format: 'slides' }
}
