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

/**
 * A deck that is one chapter's alternate rendering, i.e. that shares a `group`
 * with a chapter doc. The html view drops slide-variant entries because a deck
 * is its own view — but a PAIRED deck is a doc on its chapter's map, so
 * dropping it would leave the map unable to show it at all. An unpaired deck is
 * unaffected and still opens only as a deck.
 */
function isPairedDeck(page: HtmlPageEntry, pages: HtmlPageEntry[]) {
  if (page.variant !== 'slides' || !page.group) return false
  return pages.some(other => other.group === page.group && other.variant !== 'slides')
}

export function pagesForView(pages: HtmlPageEntry[], kind: DocumentViewKind) {
  if (kind === 'html-pages') {
    // Chapters first, in their existing order, with paired decks appended.
    // `toc.json` numbers its entries by position in the CHAPTER list, and
    // `navigateToPage` turns that number straight back into `doc.pages[n - 1]`
    // — so inserting a deck next to its chapter would silently renumber every
    // chapter after it and send the ToC to the wrong document. Which map a doc
    // belongs to is carried by `group`, not by position, so appending costs the
    // pairing nothing.
    const chapters = pages.filter(page => page.variant !== 'slides')
    const pairedDecks = pages.filter(page => isPairedDeck(page, pages))
    return pairedDecks.length > 0 ? [...chapters, ...pairedDecks] : chapters
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
