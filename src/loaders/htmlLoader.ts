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
  slideIndex?: number
  indexh?: number
  indexv?: number
  tabLabel?: string
  variant?: 'chapter' | 'slides'
  source?: {
    type?: string
    format?: string
    file?: string
  }
}

const tabSpacing = 24  // horizontal gap between side-by-side tabs

function pageUrl(info: HtmlPageEntry, basePath: string): string {
  const url = info.url || basePath + info.file
  if (info.slideIndex == null) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}_tldaH=${info.indexh ?? info.slideIndex}&_tldaV=${info.indexv ?? 0}`
}

export async function loadHtmlDocument(
  name: string,
  basePath: string,
): Promise<SvgDocument> {
  console.log(`Loading HTML document from ${basePath}`)

  const infoUrl = basePath + 'page-info.json'
  // A failed page-info fetch must not read as an empty document. The 401 body is
  // itself valid JSON, so r.json() resolves to an object, its .length is undefined,
  // and the page loop below runs zero times: a blank canvas, no throw, no error
  // boundary. App.tsx matches the status in this message to raise the auth screen.
  const response = await fetch(infoUrl)
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(`${response.status} ${body.error || response.statusText || 'could not load page-info.json'}`.trim())
  }
  const allPageInfos: HtmlPageEntry[] = await response.json()
  if (!Array.isArray(allPageInfos)) {
    throw new Error(`page-info.json for "${name}" is not a list of pages`)
  }
  const pageInfos = allPageInfos.filter(info => info.variant !== 'slides')
  return createHtmlDocumentFromPageInfo(name, basePath, pageInfos)
}

export function createHtmlDocumentFromPageInfo(
  name: string,
  basePath: string,
  pageInfos: HtmlPageEntry[],
  { reuseDefaultPage = true }: { reuseDefaultPage?: boolean } = {},
): SvgDocument {
  console.log(`Found ${pageInfos.length} HTML pages`)

  // Multipage: each chapter (or tab group) gets its own TLDraw page.
  // Shapes are placed at origin on their page — no vertical stacking.
  const pages: SvgPage[] = []
  let tldrawPageIdx = 0

  let i = 0
  while (i < pageInfos.length) {
    const info = pageInfos[i]

    if (!info.group) {
      // Normal page: own TLDraw page, shape at origin
      const pageId = `${name}-page-${i}`
      // A document's first page normally reuses TLDraw's default page. Attached
      // project parts must not: putting their first iframe on page:page lays it
      // over the primary document and intercepts every pointer event beneath it.
      const tlPageId = tldrawPageIdx === 0 && reuseDefaultPage
        ? 'page:page'
        : `page:${name}-ch-${tldrawPageIdx}`
      const pageName = info.title || info.file.replace(/\.html$/, '').replace(/-/g, ' ')
      pages.push({
        src: pageUrl(info, basePath),
        bounds: new Box(0, 0, info.width, info.height),
        assetId: AssetRecordType.createId(pageId),
        shapeId: createShapeId(pageId),
        width: info.width,
        height: info.height,
        tldrawPageId: tlPageId,
        tldrawPageName: pageName,
        source: info.source,
      })
      tldrawPageIdx++
      i++
    } else {
      // Tab group: all tabs share one TLDraw page, laid out horizontally
      const groupId = info.group
      const groupStart = i
      const tlPageId = `page:${name}-ch-${tldrawPageIdx}`
      let left = 0

      while (i < pageInfos.length && pageInfos[i].group === groupId) {
        const gp = pageInfos[i]
        const pageId = `${name}-page-${i}`
        pages.push({
          src: pageUrl(gp, basePath),
          bounds: new Box(left, 0, gp.width, gp.height),
          assetId: AssetRecordType.createId(pageId),
          shapeId: createShapeId(pageId),
          width: gp.width,
          height: gp.height,
          tldrawPageId: tlPageId,
          tldrawPageName: groupId,
          source: gp.source,
        })
        left += gp.width + tabSpacing
        i++
      }

      tldrawPageIdx++
      console.log(`  Tab group "${groupId}": ${i - groupStart} tabs`)
    }
  }

  console.log(`HTML document ready (${pageInfos.length} pages, ${tldrawPageIdx} TLDraw pages)`)
  return { name, pages, basePath, format: 'html' }
}
