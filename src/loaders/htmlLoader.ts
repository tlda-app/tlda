import {
  Box,
  AssetRecordType,
  createShapeId,
} from 'tldraw'
import type { SvgPage, SvgDocument } from './types'

export interface HtmlPageEntry {
  file: string
  width: number
  height: number
  title?: string
  tocLevel?: string
  group?: string
  groupIndex?: number
  tabLabel?: string
}

const tabSpacing = 24  // horizontal gap between side-by-side tabs

export async function loadHtmlDocument(
  name: string,
  basePath: string,
): Promise<SvgDocument> {
  console.log(`Loading HTML document from ${basePath}`)

  const infoUrl = basePath + 'page-info.json'
  const pageInfos: HtmlPageEntry[] = await fetch(infoUrl).then(r => r.json())

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
      // First page reuses TLDraw's default page ID; subsequent pages get synthetic IDs
      const tlPageId = tldrawPageIdx === 0 ? 'page:page' : `page:${name}-ch-${tldrawPageIdx}`
      const pageName = info.title || info.file.replace(/\.html$/, '').replace(/-/g, ' ')
      pages.push({
        src: basePath + info.file,
        bounds: new Box(0, 0, info.width, info.height),
        assetId: AssetRecordType.createId(pageId),
        shapeId: createShapeId(pageId),
        width: info.width,
        height: info.height,
        tldrawPageId: tlPageId,
        tldrawPageName: pageName,
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
          src: basePath + gp.file,
          bounds: new Box(left, 0, gp.width, gp.height),
          assetId: AssetRecordType.createId(pageId),
          shapeId: createShapeId(pageId),
          width: gp.width,
          height: gp.height,
          tldrawPageId: tlPageId,
          tldrawPageName: groupId,
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
