import { AssetRecordType, createShapeId } from 'tldraw'
import { PAGE_GAP } from '../layoutConstants'
import type { SvgPage, SvgDocument, SlideInfo } from './types'
import { layoutPageBounds } from './pageLayout'

export type SlidePageEntry = SlideInfo

/** Load a reveal.js deck as pages laid out on the horizontal page axis. */
export async function loadSlidesDocument(
  name: string,
  basePath: string,
): Promise<SvgDocument> {
  console.log(`Loading slides document from ${basePath}`)

  const infoUrl = basePath + 'page-info.json'
  const pageInfos: SlidePageEntry[] = await fetch(infoUrl).then(r => r.json())

  console.log(`Found ${pageInfos.length} slides`)

  const bounds = layoutPageBounds(pageInfos, 'horizontal', PAGE_GAP)
  const pages: SvgPage[] = pageInfos.map((info, index) => {
    const pageId = `${name}-slide-${index}`
    const indexh = info.indexh ?? info.slideIndex
    const indexv = info.indexv ?? 0
    return {
      src: `${basePath}${info.file}?_tldaH=${indexh}&_tldaV=${indexv}`,
      bounds: bounds[index],
      assetId: AssetRecordType.createId(pageId),
      shapeId: createShapeId(pageId),
      width: info.width,
      height: info.height,
    }
  })

  console.log(`Slides document ready (${pageInfos.length} slides, horizontal page axis)`)
  return { name, pages, basePath, format: 'slides', slideInfo: pageInfos }
}
