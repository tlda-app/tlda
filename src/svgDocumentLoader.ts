import {
  Box,
  AssetRecordType,
  createShapeId,
} from 'tldraw'
import type { TLAssetId, TLShapeId } from 'tldraw'
import { setActiveMacros } from './katexMacros'
import { extractTextFromSvgAsync, type PageTextData } from './TextSelectionLayer'
import { svgTextStore, svgViewBoxStore, anchorIndex } from './SvgPageShape'
import { TARGET_WIDTH, PAGE_GAP, PDF_WIDTH, PDF_HEIGHT } from './layoutConstants'

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

export interface DiffHighlight {
  x: number
  y: number
  w: number
  h: number
  side: 'current' | 'old'
  currentPage: number  // which diff pair this belongs to (1-indexed)
}

export interface DiffArrow {
  startX: number; startY: number  // right edge center of old highlight
  endX: number; endY: number      // left edge center of current highlight
  oldHighlightIdx: number         // index in highlights[]
  currentHighlightIdx: number     // index in highlights[]
}

export interface DiffChange {
  currentPage: number
  oldPages: number[]
}

export interface DiffLayout {
  oldPageIndices: Set<number>  // which indices in pages[] are old pages
  highlights: DiffHighlight[]
  arrows: DiffArrow[]
  changes: DiffChange[]       // pages with changes, for navigation
}

export interface SvgDocument {
  name: string
  pages: SvgPage[]
  macros?: Record<string, string>
  basePath?: string  // URL path prefix for files (e.g. "/docs/bregman/")
  format?: 'svg' | 'png' | 'html' | 'diff'
  diffLayout?: DiffLayout
}

export const pageSpacing = PAGE_GAP

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
    let height = TARGET_WIDTH

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

    // Scale to reasonable size
    const scale = TARGET_WIDTH / width
    width = width * scale
    height = height * scale

    // Use deterministic IDs based on document name + page index
    // This prevents duplicates when Yjs syncs existing shapes
    const pageId = `${name}-page-${i}`
    const shapeId = createShapeId(pageId)

    // Store raw SVG text for inline rendering (not synced through Yjs)
    svgTextStore.set(shapeId, svgText)

    // Store SVG viewBox for coordinate conversion (hyperref link navigation)
    if (svgEl) {
      const vb = svgEl.getAttribute('viewBox')
      if (vb) {
        const parts = vb.split(/\s+/).map(Number)
        if (parts.length === 4) {
          svgViewBoxStore.set(shapeId, { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] })
        }
      }
    }

    // Build anchor index from <view> elements (hyperref destinations)
    const views = doc.querySelectorAll('view')
    for (const view of views) {
      const id = view.getAttribute('id')
      if (id) {
        anchorIndex.set(id, {
          pageShapeId: shapeId,
          viewBox: view.getAttribute('viewBox') || undefined,
        })
      }
    }

    // Also keep data URL for fallback (diff overlay, old pages, etc.)
    const dataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgText)))

    pages.push({
      src: dataUrl,
      bounds: new Box(0, top, width, height),
      assetId: AssetRecordType.createId(pageId),
      shapeId,
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

  console.log(`SVG document ready (${anchorIndex.size} hyperref anchors indexed)`)
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

    // Scale to target width (matching SVG loader)
    const scale = TARGET_WIDTH / width
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

// --- Diff document loader ---

interface DiffInfoHighlight {
  page?: number
  yTop: number
  yBottom: number
}

interface DiffInfoPair {
  currentPage: number
  oldPages: number[]
  hasChanges: boolean
  newContent?: boolean
  highlights?: {
    current: DiffInfoHighlight[]
    old: DiffInfoHighlight[]
  }
}

interface DiffInfo {
  meta: { gitRef: string; generated: string }
  currentPages: number
  oldPages: number
  pairs: DiffInfoPair[]
}

const OLD_PAGE_GAP = 48  // horizontal gap between old and current columns

/**
 * Convert a synctex y-coordinate on a given page to canvas y-coordinate.
 * Synctex y coords are from page top, canvas local coords also from page top.
 */
function synctexYToCanvas(
  synctexY: number,
  pageIndex: number,
  pages: SvgPage[],
): number {
  const page = pages[pageIndex]
  if (!page) return 0
  const scaleY = page.bounds.height / PDF_HEIGHT
  return page.bounds.y + synctexY * scaleY
}

function parseSvgDimensions(svgText: string): { width: number; height: number } {
  const parser = new DOMParser()
  const doc = parser.parseFromString(svgText, 'image/svg+xml')
  const svgEl = doc.querySelector('svg')
  let width = 600, height = TARGET_WIDTH

  if (svgEl) {
    const viewBox = svgEl.getAttribute('viewBox')
    const wAttr = svgEl.getAttribute('width')
    const hAttr = svgEl.getAttribute('height')
    if (viewBox) {
      const parts = viewBox.split(/\s+/)
      if (parts.length === 4) {
        width = parseFloat(parts[2]) || width
        height = parseFloat(parts[3]) || height
      }
    }
    if (wAttr) { const w = parseFloat(wAttr); if (!isNaN(w)) width = w }
    if (hAttr) { const h = parseFloat(hAttr); if (!isNaN(h)) height = h }
  }

  const scale = TARGET_WIDTH / width
  return { width: width * scale, height: height * scale }
}

/**
 * Diff overlay data: old pages, highlights, arrows, and changes.
 * Loaded separately from the main document so it can be toggled on/off.
 */
export interface DiffData {
  pages: SvgPage[]           // old pages only (with bounds already computed)
  highlights: DiffHighlight[]
  arrows: DiffArrow[]
  changes: DiffChange[]
}

/**
 * Load diff overlay data given existing current pages.
 * Returns old pages, highlights, arrows, and changes — everything needed
 * to create diff overlay shapes on top of a normal document.
 */
export async function loadDiffData(
  name: string,
  diffBasePath: string,
  currentPages: SvgPage[],
): Promise<DiffData> {
  console.log(`Loading diff data from ${diffBasePath}`)

  const diffInfo = await fetch(diffBasePath + 'diff-info.json').then(r => r.json()) as DiffInfo

  // Determine which old pages we need
  const neededOldPages = new Set<number>()
  for (const pair of diffInfo.pairs) {
    for (const op of pair.oldPages) {
      neededOldPages.add(op)
    }
  }

  console.log(`Loading ${neededOldPages.size} old pages for diff overlay...`)

  // Fetch old SVGs
  const oldUrlMap = new Map<number, string>()
  for (const op of neededOldPages) {
    const num = String(op).padStart(2, '0')
    oldUrlMap.set(op, diffBasePath + `old-page-${num}.svg`)
  }

  const oldTexts = await Promise.all(
    [...oldUrlMap.entries()].map(async ([pageNum, url]) => {
      const text = await fetch(url).then(r => r.text())
      return { pageNum, text }
    })
  )

  // Build old pages, positioned to the left of their paired current page
  const oldPages: SvgPage[] = []
  const oldPageMap = new Map<number, { svgText: string }>()
  for (const { pageNum, text } of oldTexts) {
    oldPageMap.set(pageNum, { svgText: text })
  }

  // For building highlights, we need a combined pages array (current + old)
  // We'll build oldPages first, then construct a combined array for highlight computation
  const placedOldPages = new Set<number>()

  // Track old page positions by page number for highlight lookup
  const oldPageByNum = new Map<number, SvgPage>()

  for (const pair of diffInfo.pairs) {
    if (pair.oldPages.length === 0) continue

    const currentIdx = pair.currentPage - 1
    const currentPage = currentPages[currentIdx]
    if (!currentPage) continue

    const newOldPageNums = pair.oldPages.filter(op => !placedOldPages.has(op))
    if (newOldPageNums.length === 0) continue

    const oldDims = newOldPageNums.map(op => {
      const data = oldPageMap.get(op)
      if (!data) return { width: 800, height: 1035 }
      return parseSvgDimensions(data.svgText)
    })

    const totalOldHeight = oldDims.reduce((sum, d) => sum + d.height, 0) +
      (oldDims.length - 1) * pageSpacing
    const currentCenterY = currentPage.bounds.y + currentPage.bounds.height / 2
    let oldTop = currentCenterY - totalOldHeight / 2

    for (let j = 0; j < newOldPageNums.length; j++) {
      const opNum = newOldPageNums[j]
      const data = oldPageMap.get(opNum)
      if (!data) continue

      const { width, height } = oldDims[j]
      const dataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(data.svgText)))
      const pageId = `${name}-old-page-${opNum}`

      const oldPage: SvgPage = {
        src: dataUrl,
        bounds: new Box(-(width + OLD_PAGE_GAP), oldTop, width, height),
        assetId: AssetRecordType.createId(pageId),
        shapeId: createShapeId(pageId),
        width,
        height,
      }

      oldPages.push(oldPage)
      oldPageByNum.set(opNum, oldPage)
      placedOldPages.add(opNum)
      oldTop += height + pageSpacing
    }
  }

  // Build highlights and arrows using current pages + old pages for coordinate lookup
  const highlights: DiffHighlight[] = []
  const arrows: DiffArrow[] = []

  for (const pair of diffInfo.pairs) {
    if (!pair.highlights) continue

    const currentIdx = pair.currentPage - 1
    const currentPage = currentPages[currentIdx]
    if (!currentPage) continue

    // Current-side highlights
    const currentHlBaseIdx = highlights.length
    const currentHls: DiffHighlight[] = []
    for (const hl of pair.highlights.current) {
      const yTop = synctexYToCanvas(hl.yTop, currentIdx, currentPages)
      const yBottom = synctexYToCanvas(hl.yBottom, currentIdx, currentPages)
      const h: DiffHighlight = {
        x: currentPage.bounds.x,
        y: yTop,
        w: currentPage.bounds.width,
        h: Math.max(yBottom - yTop, 10),
        side: 'current',
        currentPage: pair.currentPage,
      }
      currentHls.push(h)
      highlights.push(h)
    }

    // Old-side highlights
    const oldHlBaseIdx = highlights.length
    const oldHls: DiffHighlight[] = []
    for (const hl of pair.highlights.old) {
      const oldPageNum = hl.page ?? pair.oldPages[0]
      if (!oldPageNum) continue

      const oldPage = oldPageByNum.get(oldPageNum)
      if (!oldPage) continue

      // For synctexYToCanvas we need the old page in an array-like lookup
      const scaleY = oldPage.bounds.height / PDF_HEIGHT
      const yTop = oldPage.bounds.y + hl.yTop * scaleY
      const yBottom = oldPage.bounds.y + hl.yBottom * scaleY

      const h: DiffHighlight = {
        x: oldPage.bounds.x,
        y: yTop,
        w: oldPage.bounds.width,
        h: Math.max(yBottom - yTop, 10),
        side: 'old',
        currentPage: pair.currentPage,
      }
      oldHls.push(h)
      highlights.push(h)
    }

    const minLen = Math.min(currentHls.length, oldHls.length)
    for (let k = 0; k < minLen; k++) {
      const cur = currentHls[k]
      const old = oldHls[k]
      arrows.push({
        startX: old.x + old.w,
        startY: old.y + old.h / 2,
        endX: cur.x,
        endY: cur.y + cur.h / 2,
        currentHighlightIdx: currentHlBaseIdx + k,
        oldHighlightIdx: oldHlBaseIdx + k,
      })
    }
  }

  const changes: DiffChange[] = diffInfo.pairs
    .filter(p => p.hasChanges)
    .map(p => ({ currentPage: p.currentPage, oldPages: p.oldPages }))

  console.log(`Diff data ready: ${oldPages.length} old pages, ${highlights.length} highlights, ${arrows.length} arrows, ${changes.length} changes`)
  return { pages: oldPages, highlights, arrows, changes }
}

export async function loadDiffDocument(
  name: string,
  basePath: string,
): Promise<SvgDocument> {
  console.log(`Loading diff document from ${basePath}`)

  // Fetch macros
  const macrosData = await fetch(basePath + 'macros.json').then(r => r.ok ? r.json() : null).catch(() => null)
  if (macrosData?.macros) {
    console.log(`Loaded ${Object.keys(macrosData.macros).length} macros from preamble`)
    setActiveMacros(macrosData.macros)
  }

  // Fetch diff-info to know how many current pages
  const diffInfo = await fetch(basePath + 'diff-info.json').then(r => r.json()) as DiffInfo

  // Build current pages (stacked vertically at x=0)
  const currentUrls = Array.from({ length: diffInfo.currentPages }, (_, i) => {
    const num = String(i + 1).padStart(2, '0')
    return basePath + `page-${num}.svg`
  })

  const currentTexts = await Promise.all(
    currentUrls.map(url => fetch(url).then(r => r.text()))
  )

  const pages: SvgPage[] = []
  const currentPageDocs: Document[] = []
  let top = 0

  for (let i = 0; i < currentTexts.length; i++) {
    const svgText = currentTexts[i]
    const { width, height } = parseSvgDimensions(svgText)
    const dataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgText)))
    const pageId = `${name}-page-${i}`

    pages.push({
      src: dataUrl,
      bounds: new Box(0, top, width, height),
      assetId: AssetRecordType.createId(pageId),
      shapeId: createShapeId(pageId),
      width,
      height,
    })

    const parser = new DOMParser()
    currentPageDocs.push(parser.parseFromString(svgText, 'image/svg+xml'))

    top += height + pageSpacing
  }

  // Load diff overlay data using current pages
  const diffData = await loadDiffData(name, basePath, pages)

  // Add old pages to the pages array
  const oldPageIndices = new Set<number>()
  for (const oldPage of diffData.pages) {
    oldPageIndices.add(pages.length)
    pages.push(oldPage)
  }

  // Extract text data for current pages
  console.log('Extracting text for selection overlay...')
  for (let i = 0; i < currentPageDocs.length; i++) {
    pages[i].textData = await extractTextFromSvgAsync(currentPageDocs[i])
  }

  console.log(`Diff document ready: ${diffInfo.currentPages} current + ${diffData.pages.length} old pages, ${diffData.highlights.length} highlights, ${diffData.changes.length} changes`)
  return {
    name,
    pages,
    basePath,
    format: 'diff',
    diffLayout: {
      oldPageIndices,
      highlights: diffData.highlights,
      arrows: diffData.arrows,
      changes: diffData.changes,
    },
  }
}

// --- Proof reader data loader ---

interface ProofInfoRegion {
  page: number
  yTop: number
  yBottom: number
}

interface ProofInfoDependency {
  label: string
  displayLabel?: string
  type: string
  shortType: string
  region: ProofInfoRegion
  pageDist: number
}

interface ProofInfoPair {
  id: string
  type: string
  title: string
  statementLines: [number, number]
  statementRegion: ProofInfoRegion
  statementRegions: ProofInfoRegion[]
  proofLines: [number, number]
  proofRegions: ProofInfoRegion[]
  samePage: boolean
  dependencies?: ProofInfoDependency[]
}

interface ProofInfoLabelRegion {
  page: number
  yTop: number
  yBottom: number
  type: string
  displayLabel: string
}

interface ProofInfo {
  meta: { texFile: string; generated: string }
  pairs: ProofInfoPair[]
  lineRefs?: Record<string, string[]>
  labelRegions?: Record<string, ProofInfoLabelRegion>
}

export interface ProofHighlight {
  x: number
  y: number
  w: number
  h: number
  pairIndex: number
}

export interface ProofDependency {
  label: string
  displayLabel: string
  type: string
  shortType: string
  region: StatementRegion
  pageDist: number
}

export interface ProofPair {
  id: string
  type: string
  title: string
  proofPageIndices: number[]  // 0-based page indices where proof lives
  statementPage: number       // 1-indexed page where statement lives
  samePage: boolean
  dependencies: ProofDependency[]
}

/** Raw synctex region for a statement, used by the overlay to compute camera bounds */
export interface StatementRegion {
  page: number      // 1-indexed
  yTop: number      // synctex y-coordinate
  yBottom: number   // synctex y-coordinate
}

export interface LabelRegion extends StatementRegion {
  type: string
  displayLabel: string
}

export interface ProofData {
  highlights: ProofHighlight[]
  pairs: ProofPair[]
  /** Raw statement regions, indexed by pair index, for the overlay camera */
  statementRegions: (StatementRegion | null)[]
  /** Line number → ordered list of ref labels on that line */
  lineRefs: Record<string, string[]>
  /** Label → region + display info */
  labelRegions: Record<string, LabelRegion>
}

/**
 * Load proof reader data given existing current pages.
 * Fetches proof-info.json, computes highlight positions and statement regions
 * for the shared-store overlay.
 */
export async function loadProofData(
  name: string,
  basePath: string,
  currentPages: SvgPage[],
): Promise<ProofData> {
  console.log(`Loading proof data from ${basePath}`)

  const proofInfo = await fetch(basePath + 'proof-info.json').then(r => r.json()) as ProofInfo

  const highlights: ProofHighlight[] = []
  const pairs: ProofPair[] = []
  const statementRegions: (StatementRegion | null)[] = []

  for (let pi = 0; pi < proofInfo.pairs.length; pi++) {
    const pair = proofInfo.pairs[pi]

    const proofPageIndices = pair.proofRegions.map(r => r.page - 1)

    // Map dependencies from JSON
    const dependencies: ProofDependency[] = (pair.dependencies || []).map(dep => ({
      label: dep.label,
      displayLabel: dep.displayLabel || dep.label,
      type: dep.type,
      shortType: dep.shortType,
      region: {
        page: dep.region.page,
        yTop: dep.region.yTop,
        yBottom: dep.region.yBottom,
      },
      pageDist: dep.pageDist,
    }))

    pairs.push({
      id: pair.id,
      type: pair.type,
      title: pair.title,
      proofPageIndices,
      statementPage: pair.statementRegion.page,
      samePage: pair.samePage,
      dependencies,
    })

    // Store raw statement region for the overlay camera
    statementRegions.push({
      page: pair.statementRegion.page,
      yTop: pair.statementRegion.yTop,
      yBottom: pair.statementRegion.yBottom,
    })

    // Create proof region highlights (light green)
    for (const region of pair.proofRegions) {
      const pageIdx = region.page - 1
      const page = currentPages[pageIdx]
      if (!page) continue

      const yTop = synctexYToCanvas(region.yTop, pageIdx, currentPages)
      const yBottom = synctexYToCanvas(region.yBottom, pageIdx, currentPages)

      highlights.push({
        x: page.bounds.x,
        y: yTop,
        w: page.bounds.width,
        h: Math.max(yBottom - yTop, 10),
        pairIndex: pi,
      })
    }
  }

  // Pass through lineRefs and labelRegions for click-to-ref
  const lineRefs: Record<string, string[]> = proofInfo.lineRefs || {}
  const labelRegions: Record<string, LabelRegion> = {}
  if (proofInfo.labelRegions) {
    for (const [label, info] of Object.entries(proofInfo.labelRegions)) {
      labelRegions[label] = {
        page: info.page,
        yTop: info.yTop,
        yBottom: info.yBottom,
        type: info.type,
        displayLabel: info.displayLabel,
      }
    }
  }

  console.log(`Proof data ready: ${highlights.length} highlights, ${pairs.length} pairs, ${Object.keys(lineRefs).length} line refs`)
  return { highlights, pairs, statementRegions, lineRefs, labelRegions }
}
