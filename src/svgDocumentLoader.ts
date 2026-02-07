import {
  Box,
  AssetRecordType,
  createShapeId,
} from 'tldraw'
import type { TLAssetId, TLShapeId } from 'tldraw'
import { setActiveMacros } from './katexMacros'
import { extractTextFromSvgAsync, type PageTextData } from './TextSelectionLayer'

// Global document info for synctex anchoring
export let currentDocumentInfo: {
  name: string
  pages: Array<{ bounds: { x: number, y: number, width: number, height: number }, width: number, height: number }>
} | null = null

export function setCurrentDocumentInfo(info: typeof currentDocumentInfo) {
  currentDocumentInfo = info
}

export interface SvgPage {
  src: string
  bounds: Box
  assetId: TLAssetId
  shapeId: TLShapeId
  width: number
  height: number
  textData?: PageTextData | null
}

export interface SvgDocument {
  name: string
  pages: SvgPage[]
  macros?: Record<string, string>
  basePath?: string  // URL path prefix for files (e.g. "/docs/bregman/")
  format?: 'svg' | 'png' | 'html'
}

export const pageSpacing = 32

export async function loadSvgDocument(name: string, svgUrls: string[]): Promise<SvgDocument> {
  // Fetch all SVGs in parallel
  console.log(`Loading ${svgUrls.length} SVG pages...`)

  // Derive macros.json path from first SVG URL
  const basePath = svgUrls[0].replace(/page-\d+\.svg$/, '')
  const macrosUrl = basePath + 'macros.json'

  // Fetch SVGs and macros in parallel
  const [svgTexts, macrosData] = await Promise.all([
    Promise.all(
      svgUrls.map(async (url) => {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Failed to fetch ${url}`)
        return response.text()
      })
    ),
    fetch(macrosUrl)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
  ])

  // Set active macros if loaded
  if (macrosData?.macros) {
    console.log(`Loaded ${Object.keys(macrosData.macros).length} macros from preamble`)
    setActiveMacros(macrosData.macros)
  }

  console.log('All SVGs fetched, processing...')

  const pages: SvgPage[] = []
  const svgDocs: Document[] = []
  let top = 0
  let widest = 0

  for (let i = 0; i < svgTexts.length; i++) {
    const svgText = svgTexts[i]

    // Parse SVG to get dimensions
    const parser = new DOMParser()
    const doc = parser.parseFromString(svgText, 'image/svg+xml')
    const svgEl = doc.querySelector('svg')

    let width = 600
    let height = 800

    if (svgEl) {
      // Try to get dimensions from viewBox or width/height attributes
      const viewBox = svgEl.getAttribute('viewBox')
      const widthAttr = svgEl.getAttribute('width')
      const heightAttr = svgEl.getAttribute('height')

      if (viewBox) {
        const parts = viewBox.split(/\s+/)
        if (parts.length === 4) {
          width = parseFloat(parts[2]) || width
          height = parseFloat(parts[3]) || height
        }
      }

      if (widthAttr) {
        const w = parseFloat(widthAttr)
        if (!isNaN(w)) width = w
      }
      if (heightAttr) {
        const h = parseFloat(heightAttr)
        if (!isNaN(h)) height = h
      }
    }

    // Scale to reasonable size (target ~800px wide)
    const scale = 800 / width
    width = width * scale
    height = height * scale

    // Convert SVG to base64 data URL (TLDraw doesn't accept blob URLs)
    const dataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgText)))

    // Use deterministic IDs based on document name + page index
    // This prevents duplicates when Yjs syncs existing shapes
    const pageId = `${name}-page-${i}`
    pages.push({
      src: dataUrl,
      bounds: new Box(0, top, width, height),
      assetId: AssetRecordType.createId(pageId),
      shapeId: createShapeId(pageId),
      width,
      height,
    })

    svgDocs.push(doc)
    top += height + pageSpacing
    widest = Math.max(widest, width)
  }

  // Center pages
  for (const page of pages) {
    page.bounds.x = (widest - page.bounds.width) / 2
  }

  // Extract text data from SVGs (async: injects CM fonts, waits for load, then measures)
  console.log('Extracting text for selection overlay...')
  for (let i = 0; i < svgDocs.length; i++) {
    pages[i].textData = await extractTextFromSvgAsync(svgDocs[i])
  }

  console.log('SVG document ready')
  return { name, pages, basePath }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = reject
    img.src = dataUrl
  })
}

export async function loadImageDocument(
  name: string,
  imageUrls: string[],
  basePath: string,
): Promise<SvgDocument> {
  console.log(`Loading ${imageUrls.length} image pages...`)

  // Fetch text-data.json for text selection overlay
  const textDataUrl = basePath + 'text-data.json'
  const [imageResults, textDataArray] = await Promise.all([
    Promise.all(
      imageUrls.map(async (url) => {
        const resp = await fetch(url)
        if (!resp.ok) throw new Error(`Failed to fetch ${url}`)
        const blob = await resp.blob()
        const dataUrl = await blobToDataUrl(blob)
        const dims = await getImageDimensions(dataUrl)
        return { dataUrl, dims }
      })
    ),
    fetch(textDataUrl)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null) as Promise<PageTextData[] | null>,
  ])

  const pages: SvgPage[] = []
  let top = 0
  let widest = 0

  for (let i = 0; i < imageResults.length; i++) {
    const { dataUrl, dims } = imageResults[i]

    // deviceScaleFactor=2, so CSS dimensions are half the natural pixel size
    let width = dims.width / 2
    let height = dims.height / 2

    // Scale to ~800px target width (matching SVG loader)
    const scale = 800 / width
    width = width * scale
    height = height * scale

    const pageId = `${name}-page-${i}`
    const page: SvgPage = {
      src: dataUrl,
      bounds: new Box(0, top, width, height),
      assetId: AssetRecordType.createId(pageId),
      shapeId: createShapeId(pageId),
      width,
      height,
    }

    // Attach pre-extracted text data if available
    if (textDataArray && textDataArray[i]) {
      page.textData = textDataArray[i]
    }

    pages.push(page)
    top += height + pageSpacing
    widest = Math.max(widest, width)
  }

  // Center pages
  for (const page of pages) {
    page.bounds.x = (widest - page.bounds.width) / 2
  }

  console.log('Image document ready')
  return { name, pages, basePath, format: 'png' }
}

interface HtmlPageEntry {
  file: string
  width: number
  height: number
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

  // Fetch page-info.json for page dimensions
  const infoUrl = basePath + 'page-info.json'
  const pageInfos: HtmlPageEntry[] = await fetch(infoUrl).then(r => r.json())

  console.log(`Found ${pageInfos.length} HTML pages`)

  const pages: SvgPage[] = []
  let top = 0
  let widest = 0

  let i = 0
  while (i < pageInfos.length) {
    const info = pageInfos[i]

    if (!info.group) {
      // Normal page: stack vertically
      const pageId = `${name}-page-${i}`
      pages.push({
        src: basePath + info.file,
        bounds: new Box(0, top, info.width, info.height),
        assetId: AssetRecordType.createId(pageId),
        shapeId: createShapeId(pageId),
        width: info.width,
        height: info.height,
      })
      top += info.height + pageSpacing
      widest = Math.max(widest, info.width)
      i++
    } else {
      // Tab group: collect consecutive pages with same group
      const groupId = info.group
      const groupStart = i
      let left = 0
      let tallest = 0

      while (i < pageInfos.length && pageInfos[i].group === groupId) {
        const gp = pageInfos[i]
        const pageId = `${name}-page-${i}`
        pages.push({
          src: basePath + gp.file,
          bounds: new Box(left, top, gp.width, gp.height),
          assetId: AssetRecordType.createId(pageId),
          shapeId: createShapeId(pageId),
          width: gp.width,
          height: gp.height,
        })
        left += gp.width + tabSpacing
        tallest = Math.max(tallest, gp.height)
        i++
      }

      const groupWidth = left - tabSpacing
      widest = Math.max(widest, groupWidth)
      top += tallest + pageSpacing

      console.log(`  Tab group "${groupId}": ${i - groupStart} tabs, width=${groupWidth}px`)
    }
  }

  // Center: single pages center within widest; tab groups center as a unit
  for (let j = 0; j < pages.length; j++) {
    const info = pageInfos[j]
    if (!info.group) {
      // Single page — center individually
      pages[j].bounds.x = (widest - pages[j].bounds.width) / 2
    }
  }
  // Center tab groups as units
  const groupOffsets = new Map<string, { startIdx: number, totalWidth: number }>()
  for (let j = 0; j < pageInfos.length; j++) {
    const g = pageInfos[j].group
    if (!g) continue
    if (!groupOffsets.has(g)) {
      // Find total width of this group
      let gw = 0
      let k = j
      while (k < pageInfos.length && pageInfos[k].group === g) {
        gw += pageInfos[k].width + tabSpacing
        k++
      }
      gw -= tabSpacing
      groupOffsets.set(g, { startIdx: j, totalWidth: gw })
    }
  }
  for (const [groupId, { startIdx, totalWidth }] of groupOffsets) {
    const offset = (widest - totalWidth) / 2
    let k = startIdx
    while (k < pageInfos.length && pageInfos[k].group === groupId) {
      pages[k].bounds.x += offset
      k++
    }
  }

  console.log(`HTML document ready (${pageInfos.length} pages, widest=${widest}px)`)
  return { name, pages, basePath, format: 'html' }
}
