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
 *
 * SVG URLs are keyed on the TEX BASE, which is what the server routes on. It is
 * NOT the project's name and it is not derivable from one. `targets` carries it,
 * and THERE IS NO FALLBACK: a caller without targets cannot know the filename,
 * and anything it invents produces a URL that 404s.
 *
 * What the invented one cost, measured 2026-08-25 on a project whose name
 * differs from its document's base name: the tab requested
 * `<projectName>-page-14.svg` and received 29 bytes of
 * `{"error":"Page out of range"}` — 62 times, every page, for the life of the
 * tab — while the real `<texBase>-page-14.svg` served 82,493 bytes. The build
 * was fine and nothing was slow. Every page had already failed, and the canvas
 * drew an empty box for each one, which is indistinguishable from still
 * loading. So the document read as perpetually about to appear.
 *
 * The comment that used to sit here asserted "targets[] is always present".
 * It is not, and asserting it is what let the fallback go unexamined for as
 * long as it did.
 *
 * There is deliberately no main-file fallback either. `link` takes several
 * document roots, so there is no single "main" one to fall back to.
 */
export function createSvgDocumentLayout(name: string, basePath: string, targets?: TargetInfo[]): SvgDocument {
  const pages: SvgPage[] = []
  const width = TARGET_WIDTH
  const height = PDF_HEIGHT * (TARGET_WIDTH / PDF_WIDTH)
  let globalIdx = 0

  if (!targets?.length) {
    throw new Error(
      `${name}: cannot lay out pages without targets — the page filename is keyed on the tex base, `
      + 'which is not derivable from the project name. Inventing one makes every page 404 silently.',
    )
  }
  const effectiveTargets = targets
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
