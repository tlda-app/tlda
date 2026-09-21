import { createHtmlDocumentFromPageInfo, type HtmlPageEntry } from './htmlLoader'
import { createSlidesDocumentFromPageInfo } from './slidesLoader'
import { createSvgDocumentLayout } from './svgLoader'
import { loadImageDocument } from './imageLoader'
import type { SvgDocument, TargetInfo } from './types'
import { documentFormatForView, documentViewKind, pagesForView, type DocumentManifest, type DocumentViewKind } from './documentFormatRouting'
import { appendToken } from '../authToken'

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
  // Carry the reader's credentials. A bare fetch sends neither the operator
  // token nor the classroom token -- the first lives in memory and the second
  // in localStorage or the page URL, and a browser attaches neither by itself.
  // Only a cookie rides automatically, so an instructor whose token is in the
  // URL was refused this file while a student whose cookie was set months ago
  // was let in: `/docs/<project>/document-manifest.json` answers 403 bare and
  // 200 with `?classroomToken=`, measured on the serving build.
  //
  // `requireClassroomDocumentAccess` already admits an instructor of a bearing
  // assignment, so this is the credential never reaching the gate rather than
  // the gate refusing them.
  const response = await fetch(appendToken(`${basePath}document-manifest.json`), { signal })
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
