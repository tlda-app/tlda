import {
  Box,
  AssetRecordType,
  createShapeId,
} from 'tldraw'
import type { SvgPage, SvgDocument, SlideInfo } from './types'

export type SlidePageEntry = SlideInfo

/**
 * Load a slides document (Quarto reveal.js deck).
 * The deck is one rendered html-page shape. Logical slides live in slideInfo;
 * SlidesNavigator drives Reveal inside the single iframe.
 */
export async function loadSlidesDocument(
  name: string,
  basePath: string,
): Promise<SvgDocument> {
  console.log(`Loading slides document from ${basePath}`)

  const infoUrl = basePath + 'page-info.json'
  const pageInfos: SlidePageEntry[] = await fetch(infoUrl).then(r => r.json())

  console.log(`Found ${pageInfos.length} slides`)

  const first = pageInfos[0]
  if (!first) {
    return { name, pages: [], basePath, format: 'slides', slideInfo: [] }
  }

  const pageId = `${name}-deck`
  const pages: SvgPage[] = [{
    src: basePath + first.file + '?_tldaDeck=1',
    bounds: new Box(0, 0, first.width, first.height),
    assetId: AssetRecordType.createId(pageId),
    shapeId: createShapeId(pageId),
    width: first.width,
    height: first.height,
  }]

  console.log(`Slides document ready (${pageInfos.length} slides, single deck iframe)`)
  return { name, pages, basePath, format: 'slides', slideInfo: pageInfos }
}
