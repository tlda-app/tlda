import {
  Box,
  AssetRecordType,
  createShapeId,
} from 'tldraw'
import { setActiveMacros } from '../katexMacros'
import { extractTextFromSvgAsync } from '../TextSelectionLayer'
import { setSvgText, svgViewBoxStore, anchorIndex } from '../stores'
import { TARGET_WIDTH, PAGE_GAP, PDF_WIDTH, PDF_HEIGHT } from '../layoutConstants'
import type { SvgPage, SvgDocument, DiffData, DiffHighlight, DiffChange } from './types'

export const pageSpacing = PAGE_GAP

/**
 * Create SVG document layout using known page dimensions — no network.
 * Pages are created as placeholders; SVGs are fetched later via fetchSvgPagesAsync.
 */
export function createSvgDocumentLayout(name: string, pageCount: number, basePath: string): SvgDocument {
  const pages: SvgPage[] = []
  const width = TARGET_WIDTH
  const height = PDF_HEIGHT * (TARGET_WIDTH / PDF_WIDTH)
  let top = 0

  for (let i = 0; i < pageCount; i++) {
    const pageId = `${name}-page-${i}`
    pages.push({
      src: '',
      bounds: new Box(0, top, width, height),
      assetId: AssetRecordType.createId(pageId),
      shapeId: createShapeId(pageId),
      width,
      height,
    })
    top += height + pageSpacing
  }

  // Kick off macros fetch (non-blocking — macros ready before user types a note)
  const cacheBust = `?t=${Date.now()}`
  fetch(basePath + 'macros.json' + cacheBust)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data?.macros) {
        console.log(`Loaded ${Object.keys(data.macros).length} macros from preamble`)
        setActiveMacros(data.macros)
      }
    })
    .catch(() => {})

  console.log(`SVG document layout ready: ${pageCount} pages`)
  return { name, pages, basePath }
}

/**
 * Legacy: fetch all SVGs synchronously and return a fully-loaded document.
 * Used only for formats that need all content upfront (diff).
 */
export async function loadSvgDocument(name: string, svgUrls: string[]): Promise<SvgDocument> {
  console.log(`Loading ${svgUrls.length} SVG pages...`)

  const basePath = svgUrls[0].replace(/page-\d+\.svg$/, '')
  const macrosUrl = basePath + 'macros.json'

  const cacheBust = `?t=${Date.now()}`
  const [svgTexts, macrosData] = await Promise.all([
    Promise.all(
      svgUrls.map(async (url) => {
        let response = await fetch(url + cacheBust)
        if (!response.ok) {
          await new Promise(r => setTimeout(r, 1000))
          response = await fetch(url + `?t=${Date.now()}`)
          if (!response.ok) throw new Error(`Failed to fetch ${url}`)
        }
        return response.text()
      })
    ),
    fetch(macrosUrl + cacheBust)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
  ])

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

    const parser = new DOMParser()
    const doc = parser.parseFromString(svgText, 'image/svg+xml')
    const svgEl = doc.querySelector('svg')

    let width = 600
    let height = TARGET_WIDTH

    if (svgEl) {
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

    const scale = TARGET_WIDTH / width
    width = width * scale
    height = height * scale

    const pageId = `${name}-page-${i}`
    const shapeId = createShapeId(pageId)

    setSvgText(shapeId, svgText)

    if (svgEl) {
      const vb = svgEl.getAttribute('viewBox')
      if (vb) {
        const parts = vb.split(/\s+/).map(Number)
        if (parts.length === 4) {
          svgViewBoxStore.set(shapeId, { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] })
        }
      }
    }

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

  for (const page of pages) {
    page.bounds.x = (widest - page.bounds.width) / 2
  }

  console.log('Extracting text for selection overlay...')
  for (let i = 0; i < svgDocs.length; i++) {
    pages[i].textData = await extractTextFromSvgAsync(svgDocs[i])
  }

  console.log(`SVG document ready (${anchorIndex.size} hyperref anchors indexed)`)
  return { name, pages, basePath }
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

const OLD_PAGE_GAP = 48

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
 * Load diff overlay data given existing current pages.
 * Returns old pages, highlights, arrows, and changes.
 */
export async function loadDiffData(
  name: string,
  diffBasePath: string,
  currentPages: SvgPage[],
): Promise<DiffData> {
  console.log(`Loading diff data from ${diffBasePath}`)

  const diffInfo = await fetch(diffBasePath + 'diff-info.json').then(r => r.json()) as DiffInfo

  const neededOldPages = new Set<number>()
  for (const pair of diffInfo.pairs) {
    for (const op of pair.oldPages) {
      neededOldPages.add(op)
    }
  }

  console.log(`Loading ${neededOldPages.size} old pages for diff overlay...`)

  const oldUrlMap = new Map<number, string>()
  for (const op of neededOldPages) {
    oldUrlMap.set(op, diffBasePath + `old-page-${op}.svg`)
  }

  const oldTexts = await Promise.all(
    [...oldUrlMap.entries()].map(async ([pageNum, url]) => {
      const text = await fetch(url).then(r => r.text())
      return { pageNum, text }
    })
  )

  const oldPages: SvgPage[] = []
  const oldPageMap = new Map<number, { svgText: string }>()
  for (const { pageNum, text } of oldTexts) {
    oldPageMap.set(pageNum, { svgText: text })
  }

  const placedOldPages = new Set<number>()
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

  const highlights: DiffHighlight[] = []
  const arrows: import('./types').DiffArrow[] = []

  for (const pair of diffInfo.pairs) {
    if (!pair.highlights) continue

    const currentIdx = pair.currentPage - 1
    const currentPage = currentPages[currentIdx]
    if (!currentPage) continue

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

    const oldHlBaseIdx = highlights.length
    const oldHls: DiffHighlight[] = []
    for (const hl of pair.highlights.old) {
      const oldPageNum = hl.page ?? pair.oldPages[0]
      if (!oldPageNum) continue

      const oldPage = oldPageByNum.get(oldPageNum)
      if (!oldPage) continue

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
  const cacheBust = `?t=${Date.now()}`

  const macrosData = await fetch(basePath + 'macros.json' + cacheBust).then(r => r.ok ? r.json() : null).catch(() => null)
  if (macrosData?.macros) {
    console.log(`Loaded ${Object.keys(macrosData.macros).length} macros from preamble`)
    setActiveMacros(macrosData.macros)
  }

  const diffInfo = await fetch(basePath + 'diff-info.json' + cacheBust).then(r => r.json()) as DiffInfo

  const currentUrls = Array.from({ length: diffInfo.currentPages }, (_, i) => {
    return basePath + `page-${i + 1}.svg`
  })

  const currentTexts = await Promise.all(
    currentUrls.map(url => fetch(url + cacheBust).then(r => r.text()))
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

  const diffData = await loadDiffData(name, basePath, pages)

  const oldPageIndices = new Set<number>()
  for (const oldPage of diffData.pages) {
    oldPageIndices.add(pages.length)
    pages.push(oldPage)
  }

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
