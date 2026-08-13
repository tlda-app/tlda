import {
  Box,
  AssetRecordType,
  createShapeId,
} from 'tldraw'
import type { SvgPage, SvgDocument } from './types'

export interface HtmlPageEntry {
  file: string
  url?: string
  width: number
  height: number
  title?: string
  tocLevel?: string
  group?: string
  groupIndex?: number
  tabLabel?: string
  source?: {
    type?: string
    format?: string
    file?: string
  }
}

const tabSpacing = 24  // horizontal gap between side-by-side tabs

/** Vertical distance between two of a project's documents on its canvas page.
 *
 *  Documents are stacked rather than packed: an html-page shape is created at
 *  its page-info height and then grows to its real content height when the
 *  iframe reports back (`tlda-resize`), so anything laid out against the
 *  initial 1200px would overlap as soon as the documents loaded. The stride is
 *  the spatial world's WORLD_GAP, the separation documents already stand at in
 *  this app, and no document reaches it. */
const documentStride = 90_000

export async function loadHtmlDocument(
  name: string,
  basePath: string,
): Promise<SvgDocument> {
  console.log(`Loading HTML document from ${basePath}`)

  const infoUrl = basePath + 'page-info.json'
  const pageInfos: HtmlPageEntry[] = await fetch(infoUrl).then(r => r.json())
  return createHtmlDocumentFromPageInfo(name, basePath, pageInfos)
}

export function createHtmlDocumentFromPageInfo(
  name: string,
  basePath: string,
  pageInfos: HtmlPageEntry[],
  { reuseDefaultPage = true }: { reuseDefaultPage?: boolean } = {},
): SvgDocument {
  console.log(`Found ${pageInfos.length} HTML pages`)

  // Every document a project has lives on the project's ONE canvas page, one
  // below the next. A document is a place in the project's world, not a canvas
  // of its own — giving each entry its own TLDraw page is what a book does with
  // its chapters, and a project whose main file links to other documents is not
  // a book. Skip, 2026-08-13 01:16 EDT: "All documents should be on the current
  // fucking Canvas page, dude" and "that might be appropriate for a book. This
  // is not a book."
  //
  // A tab group is the one thing still laid out horizontally, because that is
  // what side-by-side space means here: explicit comparison, as the marked
  // exercise pair uses it. It occupies one slot in the stack.
  const pages: SvgPage[] = []
  // Attached project parts must not land on page:page: putting their iframes
  // over the primary document intercepts every pointer event beneath it.
  const tlPageId = reuseDefaultPage ? 'page:page' : `page:${name}-ch-0`
  let slot = 0

  let i = 0
  while (i < pageInfos.length) {
    const info = pageInfos[i]
    const top = slot * documentStride

    if (!info.group) {
      const pageId = `${name}-page-${i}`
      pages.push({
        src: info.url || basePath + info.file,
        bounds: new Box(0, top, info.width, info.height),
        assetId: AssetRecordType.createId(pageId),
        shapeId: createShapeId(pageId),
        width: info.width,
        height: info.height,
        tldrawPageId: tlPageId,
        tldrawPageName: name,
        spatialWorldTitle: slot === 0
          ? undefined
          : info.title || info.file.replace(/\.html$/, '').replace(/-/g, ' '),
        source: info.source,
      })
      i++
    } else {
      const groupId = info.group
      const groupStart = i
      let left = 0

      while (i < pageInfos.length && pageInfos[i].group === groupId) {
        const gp = pageInfos[i]
        const pageId = `${name}-page-${i}`
        pages.push({
          src: gp.url || basePath + gp.file,
          bounds: new Box(left, top, gp.width, gp.height),
          assetId: AssetRecordType.createId(pageId),
          shapeId: createShapeId(pageId),
          width: gp.width,
          height: gp.height,
          tldrawPageId: tlPageId,
          tldrawPageName: name,
          spatialWorldTitle: slot === 0 ? undefined : gp.title || groupId,
          source: gp.source,
        })
        left += gp.width + tabSpacing
        i++
      }

      console.log(`  Tab group "${groupId}": ${i - groupStart} tabs`)
    }
    slot++
  }

  console.log(`HTML document ready (${pageInfos.length} pages, ${slot} documents on one canvas page)`)
  return { name, pages, basePath, format: 'html' }
}
