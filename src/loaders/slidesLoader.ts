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
  // Same gate, same failure as htmlLoader: /docs/* answers 401 with a JSON body,
  // so an unchecked r.json() hands this a non-array and the deck loads empty.
  const response = await fetch(infoUrl)
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(`${response.status} ${body.error || response.statusText || 'could not load page-info.json'}`.trim())
  }
  const allPageInfos: SlidePageEntry[] = await response.json()
  if (!Array.isArray(allPageInfos)) {
    throw new Error(`page-info.json for "${name}" is not a list of pages`)
  }
  const slideVariant = allPageInfos.filter(info => info.variant === 'slides')
  const pageInfos = slideVariant.length > 0 ? slideVariant : allPageInfos

  console.log(`Found ${pageInfos.length} slides`)

  // Skip: "make the slides be spaced out a bit more so they're kind of more in
  // different places. Because right now, I can often see one... so maybe the
  // slides should be half a slide. Apart." At a fixed 32 the neighbouring slide
  // bleeds into the one you are reading.
  //
  // PAGE_GAP is the gap between STACKED pages, and it was being reused here as a
  // horizontal one. A deck's gap is a fraction of a slide rather than a constant
  // — it has to scale with the slide, because what it separates is slides.
  const slideWidth = pageInfos[0]?.width ?? 0
  const bounds = layoutPageBounds(pageInfos, 'horizontal', Math.round(slideWidth / 2) || PAGE_GAP)
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
