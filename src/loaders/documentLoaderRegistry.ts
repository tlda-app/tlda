import { createSvgDocumentLayout } from './svgLoader'
import { createHtmlDocumentFromPageInfo } from './htmlLoader'
import { createSlidesDocumentFromPageInfo } from './slidesLoader'
import { loadImageDocument } from './imageLoader'
import type { SvgDocument, TargetInfo } from './types'

export interface DocumentManifestPage {
  file: string
  width: number
  height: number
  title?: string
  slideIndex?: number
  indexh?: number
  indexv?: number
  source?: { type?: string; format?: string; file?: string }
}

export interface DocumentViewManifest {
  pages: DocumentManifestPage[]
  view: { kind: 'svg-pages' | 'html-pages' | 'slides' | 'image-pages'; capabilities: Record<string, boolean> }
}

export interface DocumentLoaderContext {
  name: string
  basePath: string
  manifest: DocumentViewManifest
  targets?: TargetInfo[]
}

const loaders: Record<DocumentViewManifest['view']['kind'], (context: DocumentLoaderContext) => Promise<SvgDocument>> = {
  'svg-pages': async ({ name, basePath, manifest, targets }) =>
    createSvgDocumentLayout(name, manifest.pages.length, basePath, targets, manifest.pages),
  'html-pages': async ({ name, basePath, manifest }) =>
    createHtmlDocumentFromPageInfo(name, basePath, manifest.pages),
  slides: async ({ name, basePath, manifest }) =>
    createSlidesDocumentFromPageInfo(name, basePath, manifest.pages.map((page, index) => ({
      ...page, slideIndex: page.slideIndex ?? index,
    }))),
  'image-pages': async ({ name, basePath, manifest }) =>
    loadImageDocument(name, manifest.pages.map(page => `${basePath}${page.file}`), basePath),
}

export function registeredDocumentLoaders() {
  return Object.keys(loaders)
}

export async function loadDocumentFromManifest(context: DocumentLoaderContext) {
  const loader = loaders[context.manifest.view.kind]
  if (!loader) throw new Error(`No document loader registered for ${context.manifest.view.kind}`)
  return loader(context)
}
