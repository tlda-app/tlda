/**
 * HTML document coordinate mapping — local page coords ↔ canvas coordinates.
 */
import { readJsonSync } from '../data-source.mjs'
import { PAGE_GAP } from './pdfCoords.mjs'

const pageInfoCache = new Map()
const HTML_PAGE_SPACING = PAGE_GAP
const HTML_TAB_SPACING = 24

export function loadHtmlLayout(docName) {
  if (pageInfoCache.has(docName)) return pageInfoCache.get(docName)
  const pageInfos = readJsonSync(docName, 'page-info.json')
  if (!pageInfos) return null
  const layout = computeHtmlLayout(pageInfos)
  pageInfoCache.set(docName, layout)
  return layout
}

export function clearHtmlLayoutCache(docName) {
  if (docName) {
    pageInfoCache.delete(docName)
  } else {
    pageInfoCache.clear()
  }
}

function computeHtmlLayout(pageInfos) {
  const pages = []
  let top = 0
  let widest = 0
  let i = 0

  while (i < pageInfos.length) {
    const info = pageInfos[i]
    if (!info.group) {
      pages.push({ x: 0, y: top, width: info.width, height: info.height })
      top += info.height + HTML_PAGE_SPACING
      widest = Math.max(widest, info.width)
      i++
    } else {
      const groupId = info.group
      let left = 0
      let tallest = 0
      while (i < pageInfos.length && pageInfos[i].group === groupId) {
        const gp = pageInfos[i]
        pages.push({ x: left, y: top, width: gp.width, height: gp.height })
        left += gp.width + HTML_TAB_SPACING
        tallest = Math.max(tallest, gp.height)
        i++
      }
      const groupWidth = left - HTML_TAB_SPACING
      widest = Math.max(widest, groupWidth)
      top += tallest + HTML_PAGE_SPACING
    }
  }

  // Center: single pages individually, tab groups as units
  for (let j = 0; j < pages.length; j++) {
    if (!pageInfos[j].group) {
      pages[j].x = (widest - pages[j].width) / 2
    }
  }
  const groupOffsets = new Map()
  for (let j = 0; j < pageInfos.length; j++) {
    const g = pageInfos[j].group
    if (!g || groupOffsets.has(g)) continue
    let gw = 0, k = j
    while (k < pageInfos.length && pageInfos[k].group === g) {
      gw += pageInfos[k].width + HTML_TAB_SPACING
      k++
    }
    gw -= HTML_TAB_SPACING
    groupOffsets.set(g, { startIdx: j, totalWidth: gw })
  }
  for (const [, { startIdx, totalWidth }] of groupOffsets) {
    const offset = (widest - totalWidth) / 2
    let k = startIdx
    while (k < pageInfos.length && pageInfos[k].group === pageInfos[startIdx].group) {
      pages[k].x += offset
      k++
    }
  }

  return { pages, widest }
}

export function htmlToCanvas(docName, page, localX, localY) {
  const layout = loadHtmlLayout(docName)
  if (!layout || page < 1 || page > layout.pages.length) return null
  const p = layout.pages[page - 1]
  return { x: p.x + localX, y: p.y + localY }
}

export function canvasToHtml(docName, canvasX, canvasY) {
  const layout = loadHtmlLayout(docName)
  if (!layout) return null
  let bestMatch = null
  let bestDist = Infinity
  for (let i = 0; i < layout.pages.length; i++) {
    const p = layout.pages[i]
    if (canvasY >= p.y && canvasY < p.y + p.height + HTML_PAGE_SPACING) {
      if (canvasX >= p.x && canvasX < p.x + p.width) {
        return { page: i + 1, localX: canvasX - p.x, localY: canvasY - p.y }
      }
      const dx = canvasX < p.x ? p.x - canvasX : canvasX - (p.x + p.width)
      if (dx < bestDist) {
        bestDist = dx
        bestMatch = i
      }
    }
  }
  if (bestMatch !== null) {
    const p = layout.pages[bestMatch]
    return { page: bestMatch + 1, localX: canvasX - p.x, localY: canvasY - p.y }
  }
  const last = layout.pages.length
  const lp = layout.pages[last - 1]
  return { page: last, localX: canvasX - lp.x, localY: canvasY - lp.y }
}
