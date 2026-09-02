import { Box, AssetRecordType, createShapeId } from 'tldraw'
import type { SvgPage, SvgDocument, SlideInfo } from './types'
import { deckLayout, type DeckSlide } from './deckLayout'

export type SlidePageEntry = SlideInfo

/**
 * Load a reveal deck as ONE document on the canvas.
 *
 * The deck used to be cut into one HTML document per slide so it would fit
 * canvas coordinates. That is what broke it: quarto-live gives one webR session
 * per DOCUMENT, so 31 slides meant 31 sessions and a name defined on one slide
 * was invisible to the rest. Measured on a 31-slide deck, 20 of the 24
 * cell-bearing documents referenced a name defined on an earlier slide.
 *
 * So the document stays whole and the window manager adapts to it. `deckLayout`
 * decides where each address sits; the shape is sized to the whole strip and the
 * CANVAS pans across it — the iframe itself never scrolls, because reveal's
 * scroll container would otherwise clip the strip it just laid out.
 */
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

  const deck = pageInfos[0]
  if (!deck) {
    return { name, pages: [], basePath, format: 'slides', slideInfo: [] }
  }

  // The address space, from the build. It agrees exactly with what reveal
  // reports at runtime from getIndices(el) — checked on a 31-slide deck, both
  // give maxH 3, maxV 20, 4 distinct columns. Reveal's own getHorizontalSlides()
  // and getVerticalSlides() agree with NEITHER (2 and 0 on that deck), which is
  // why nothing here asks them.
  const slides: DeckSlide[] = deck.slides ?? []
  const layout = deckLayout(slides, { width: deck.width, height: deck.height })

  console.log(`Found a deck of ${slides.length} slides`)

  const pageId = `${name}-deck`
  const pages: SvgPage[] = [{
    // `_tldaDeck=1` is what puts the injected bridge in deck mode: it keeps the
    // whole Reveal instance alive instead of locking to one slide, and reveal's
    // scroll view (`view=scroll`, which only takes at INITIALIZE — configure()
    // and toggleScrollView() after load silently do not) is what gives every
    // slide a real box for us to position.
    src: `${basePath}${deck.file}?_tldaDeck=1&view=scroll`,
    bounds: new Box(0, 0, layout.stripWidth, layout.stripHeight),
    assetId: AssetRecordType.createId(pageId),
    shapeId: createShapeId(pageId),
    width: layout.stripWidth,
    height: layout.stripHeight,
  }]

  console.log(`Slides document ready (one deck document, ${slides.length} slides, ${layout.stripWidth}×${layout.stripHeight})`)
  return { name, pages, basePath, format: 'slides', slideInfo: pageInfos, deckLayout: layout }
}
