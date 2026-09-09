import { createHtmlDocumentFromPageInfo, type HtmlPageEntry } from './htmlLoader'
import { createSlidesDocumentFromPageInfo } from './slidesLoader'
import { createSvgDocumentLayout } from './svgLoader'
import { loadImageDocument } from './imageLoader'
import type { SvgDocument, TargetInfo } from './types'
import { documentFormatForView, documentViewKind, pagesForView, type DocumentManifest, type DocumentViewKind } from './documentFormatRouting'

export { clientOpenKind, documentFormatForView, documentViewKind, pagesForView, projectInfoUrl } from './documentFormatRouting'
export type { DocumentManifest, DocumentViewKind } from './documentFormatRouting'

export interface DocumentLoadRequest {
  name: string
  basePath: string
  manifest: DocumentManifest
  targets?: TargetInfo[]
  viewKind?: DocumentViewKind
  pages?: HtmlPageEntry[]
}

export async function fetchDocumentManifest(basePath: string, signal?: AbortSignal): Promise<DocumentManifest> {
  const response = await fetch(`${basePath}document-manifest.json`, { signal })
  if (!response.ok) throw new Error(`${response.status} could not load document-manifest.json`)
  return response.json()
}

export async function loadDocumentByFormat({ name, basePath, manifest, targets, viewKind, pages: requestedPages }: DocumentLoadRequest): Promise<SvgDocument> {
  const kind = viewKind || documentViewKind(manifest)
  const pages = pagesForView(requestedPages || manifest.pages, kind)
  let document: SvgDocument

  if (kind === 'html-pages') {
    document = createHtmlDocumentFromPageInfo(name, basePath, pages)
  } else if (kind === 'slides') {
    document = createSlidesDocumentFromPageInfo(name, basePath, pages)
  } else if (kind === 'image-pages') {
    document = await loadImageDocument(name, pages.map(page => `${basePath}${page.file}`), basePath)
  } else {
    let pageOffset = 0
    const layoutTargets = targets?.map(target => {
      const pageSizes = pages.slice(pageOffset, pageOffset + target.pages)
        .map(page => ({ width: page.width, height: page.height }))
      pageOffset += target.pages
      return { ...target, pageSizes }
    })
    document = createSvgDocumentLayout(name, basePath, layoutTargets)
  }

  return {
    ...document,
    format: documentFormatForView(kind, manifest.source.format),
    view: { ...manifest.view, kind },
    source: manifest.source,
    documentFormat: manifest.document.format,
  }
}
