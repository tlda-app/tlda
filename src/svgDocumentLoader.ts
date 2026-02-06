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
  basePath?: string  // URL path prefix for SVG files (e.g. "/docs/bregman/")
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
