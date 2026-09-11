import type { HtmlPageEntry } from './htmlLoader'

export type DocumentViewKind = 'svg-pages' | 'html-pages' | 'slides' | 'image-pages'

export interface DocumentManifest {
  source: { format: string; renderer: string; root?: string }
  document: { format: string }
  pages: HtmlPageEntry[]
  view: {
    kind: DocumentViewKind
    capabilities: { presentation: boolean; sourceMapping: boolean; searchableText: boolean }
  }
}

export function documentViewKind(manifest: DocumentManifest) {
  return manifest.view.kind
}

export function documentFormatForView(kind: DocumentViewKind, sourceFormat: string) {
  if (kind === 'html-pages') return 'html'
  if (kind === 'slides') return 'slides'
  if (kind === 'image-pages') return 'png'
  return sourceFormat === 'pdf' ? 'pdf' : 'svg'
}

export function pagesForView(pages: HtmlPageEntry[], kind: DocumentViewKind) {
  if (kind === 'html-pages') {
    // The builder has already put chapters first and appended every deck, so
    // keeping its order preserves toc.json's page numbers. `group` decides
    // whether a deck shares its chapter's map or gets a map of its own; being
    // unpaired does not make a published document disappear from the book.
    return pages
  }
  if (kind === 'slides') {
    const slides = pages.filter(page => page.variant === 'slides')
    return slides.length > 0 ? slides : pages
  }
  return pages
}

export function clientOpenKind(project: { format?: string; documentFormat?: string }) {
  return project.documentFormat === 'book' || project.format === 'book' ? 'book' : 'document'
}

export function projectInfoUrl(storeHttp: string, project: string) {
  return `${storeHttp}/api/projects/${encodeURIComponent(project)}`
}
