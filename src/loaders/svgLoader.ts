import {
  Box,
  AssetRecordType,
  createShapeId,
} from 'tldraw'
import { setActiveMacros } from '../katexMacros'
import { extractTextFromSvgAsync } from '../TextSelectionLayer'
import { setSvgText, svgViewBoxStore, anchorIndex, setPageUrl } from '../stores'
import { TARGET_WIDTH, PAGE_GAP, PDF_WIDTH, PDF_HEIGHT } from '../layoutConstants'
import type { SvgPage, SvgDocument, TargetInfo } from './types'
import { layoutPageBounds } from './pageLayout'

export const pageSpacing = PAGE_GAP

/**
 * Create SVG document layout using known page dimensions — no network.
 * Pages are created as placeholders; SVGs are fetched later via SvgPageShape viewport entry.
 * targets[] is always present — single-target is the N=1 case.
 * SVG URLs are flat: /docs/<project>/<texBase>-page-N.svg
 */
export function createSvgDocumentLayout(name: string, pageCount: number, basePath: string, targets?: TargetInfo[]): SvgDocument {
  const pages: SvgPage[] = []
  const width = TARGET_WIDTH
  const height = PDF_HEIGHT * (TARGET_WIDTH / PDF_WIDTH)
  let globalIdx = 0

  const effectiveTargets = targets || [{ name, title: name, pages: pageCount, basePath }]
  const pageBounds = layoutPageBounds(
    effectiveTargets.flatMap(target =>
      Array.from({ length: target.pages }, () => ({ width, height }))
    ),
    'vertical',
    pageSpacing,
  )

  for (const target of effectiveTargets) {
    for (let i = 0; i < target.pages; i++) {
      const pageId = effectiveTargets.length > 1
        ? `${name}-${target.name}-page-${i}`
        : `${name}-page-${i}`
      const svgUrl = `${basePath}${target.name}-page-${i + 1}.svg`
      setPageUrl(globalIdx, svgUrl)
      pages.push({
        src: '',
        bounds: pageBounds[globalIdx],
        assetId: AssetRecordType.createId(pageId),
        shapeId: createShapeId(pageId),
        width,
        height,
        targetBasePath: basePath,
        pageInTarget: i + 1,
        targetName: target.name,
      })
      globalIdx++
    }
  }

  // Kick off macros fetch via API (primary target's preamble macros)
  const macrosUrl = basePath.replace(/\/docs\/([^/]+)\/$/, '/api/projects/$1/macros')
  fetch(macrosUrl + `?t=${Date.now()}`)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data?.macros) {
        console.log(`Loaded ${Object.keys(data.macros).length} macros from preamble`)
        setActiveMacros(data.macros)
      }
    })
    .catch(e => console.warn('[svg-loader] macros fetch failed:', e.message))

  console.log(`SVG document layout ready: ${pages.length} pages (${effectiveTargets.length} target${effectiveTargets.length > 1 ? 's' : ''})`)
  return { name, pages, basePath, targets: effectiveTargets }
}

/** Legacy: fetch all SVGs synchronously and return a fully-loaded document. */
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
