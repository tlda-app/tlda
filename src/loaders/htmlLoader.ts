import {
  Box,
  AssetRecordType,
  createShapeId,
} from 'tldraw'
import type { SvgPage, SvgDocument } from './types'
import type { DeckSlide } from './deckLayout'

export interface HtmlPageEntry {
  file: string
  url?: string
  width: number
  height: number
  title?: string
  tocLevel?: string
  group?: string
  groupIndex?: number
  slideIndex?: number
  indexh?: number
  indexv?: number
  tabLabel?: string
  variant?: 'chapter' | 'slides'
  slides?: DeckSlide[]
  source?: {
    type?: string
    format?: string
    file?: string
  }
}

const tabSpacing = 24  // horizontal gap between side-by-side tabs

function pageUrl(info: HtmlPageEntry, basePath: string): string {
  const url = info.url || basePath + info.file
  if (info.slideIndex == null) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}_tldaH=${info.indexh ?? info.slideIndex}&_tldaV=${info.indexv ?? 0}`
}

export async function loadHtmlDocument(
  name: string,
  basePath: string,
): Promise<SvgDocument> {
  console.log(`Loading HTML document from ${basePath}`)

  const infoUrl = basePath + 'page-info.json'
  // A failed page-info fetch must not read as an empty document. The 401 body is
  // itself valid JSON, so r.json() resolves to an object, its .length is undefined,
  // and the page loop below runs zero times: a blank canvas, no throw, no error
  // boundary. App.tsx matches the status in this message to raise the auth screen.
  const response = await fetch(infoUrl)
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(`${response.status} ${body.error || response.statusText || 'could not load page-info.json'}`.trim())
  }
  const allPageInfos: HtmlPageEntry[] = await response.json()
  if (!Array.isArray(allPageInfos)) {
    throw new Error(`page-info.json for "${name}" is not a list of pages`)
  }
  const pageInfos = allPageInfos.filter(info => info.variant !== 'slides')
  return createHtmlDocumentFromPageInfo(name, basePath, pageInfos)
}

/**
 * The map an entry belongs to, or null for one map of its own.
 *
 * A map is one TLDraw page holding one chapter's docs — the prose chapter and,
 * where one exists, its deck. `group` is the builder's statement of which
 * chapter an entry belongs to, and it is the ONLY thing read here: pairing a
 * deck with a chapter is the builder's decision (it knows the book's render
 * lists and the `<chapter>-slides.qmd` stem rule), and re-deriving it from
 * paths in the viewer would be a second answer that can disagree with the
 * first.
 *
 * An entry with no `group` gets a map of its own, keyed by position exactly as
 * before — which is every entry of every format that does not emit `group`, so
 * a non-book project's TLDraw page ids are unchanged by the map layer.
 */
function mapKeyOf(info: HtmlPageEntry): string | null {
  return info.group || null
}

/** A readable, stable TLDraw page id for a map key. */
function mapSlug(key: string, taken: Set<string>): string {
  const base = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'map'
  // Two different keys can slug to one string (`a/b.qmd` and `a-b.qmd`). Two
  // maps sharing a TLDraw page id would silently merge two chapters, so
  // disambiguate by order of first appearance rather than let that happen.
  let slug = base
  let n = 2
  while (taken.has(slug)) slug = `${base}-${n++}`
  taken.add(slug)
  return slug
}

export function createHtmlDocumentFromPageInfo(
  name: string,
  basePath: string,
  pageInfos: HtmlPageEntry[],
  { reuseDefaultPage = true }: { reuseDefaultPage?: boolean } = {},
): SvgDocument {
  console.log(`Found ${pageInfos.length} HTML pages`)

  // Collect each map's entries, in first-appearance order. Grouping is by key
  // across the whole list, not by adjacency: on the book path a chapter comes
  // from the book's render list and its deck from a separate profile pass, so
  // the two entries of one chapter are not neighbours.
  const maps: Array<{ key: string | null; entries: Array<{ info: HtmlPageEntry; index: number }> }> = []
  const mapsByKey = new Map<string, (typeof maps)[number]>()
  for (let i = 0; i < pageInfos.length; i++) {
    const info = pageInfos[i]
    const key = mapKeyOf(info)
    if (key === null) {
      maps.push({ key: null, entries: [{ info, index: i }] })
      continue
    }
    const existing = mapsByKey.get(key)
    if (existing) {
      existing.entries.push({ info, index: i })
      continue
    }
    const created = { key, entries: [{ info, index: i }] }
    mapsByKey.set(key, created)
    maps.push(created)
  }

  const pages: SvgPage[] = []
  const takenSlugs = new Set<string>()
  // A map-keyed document takes no positional page at all, INCLUDING the default
  // one. Letting the first map reuse `page:page` would leave exactly one chapter
  // identified by its position, so reordering the book's chapter list would move
  // that chapter — and its annotations — onto a different chapter's page. That
  // is the failure the map layer exists to prevent, and one exception to the
  // rule is enough to reintroduce it.
  const mapKeyed = maps.some(map => map.key !== null)

  // Where each entry ends up, worked out per map and then read back in
  // page-info order below.
  const placements = new Map<number, { tlPageId: string; pageName: string; left: number }>()
  for (let m = 0; m < maps.length; m++) {
    const map = maps[m]
    // A document's first page otherwise reuses TLDraw's default page. Attached
    // project parts must not: putting their first iframe on page:page lays it
    // over the primary document and intercepts every pointer event beneath it.
    const tlPageId = m === 0 && reuseDefaultPage && !mapKeyed
      ? 'page:page'
      : map.key === null
        ? `page:${name}-ch-${m}`
        : `page:${name}-map-${mapSlug(map.key, takenSlugs)}`

    // Name the map after the chapter, never after the group id — a group id is
    // a source path (`lectures/chapter-sampling.qmd`), and a list of file paths
    // is not a thing anyone navigates a book by.
    const named = map.entries.find(e => e.info.variant !== 'slides') || map.entries[0]
    const pageName = named.info.title
      || named.info.file.replace(/\.html$/, '').replace(/-/g, ' ')

    // Several docs on one map sit side by side, which is what the chapter/deck
    // pairing has always looked like.
    let left = 0
    for (const { info, index } of map.entries) {
      placements.set(index, { tlPageId, pageName, left })
      left += info.width + tabSpacing
    }
    if (map.entries.length > 1) {
      console.log(`  Map "${pageName}": ${map.entries.length} docs`)
    }
  }

  // In page-info order, NOT grouped by map. `toc.json` numbers its entries by
  // position in this list and `navigateToPage` reads `doc.pages[n - 1]`
  // straight back out of it, so grouping the array by map would send every ToC
  // entry after the first paired chapter to the wrong document — with nothing
  // about it looking broken.
  for (let i = 0; i < pageInfos.length; i++) {
    const info = pageInfos[i]
    const placement = placements.get(i)!
    const pageId = `${name}-page-${i}`
    pages.push({
      src: pageUrl(info, basePath),
      bounds: new Box(placement.left, 0, info.width, info.height),
      assetId: AssetRecordType.createId(pageId),
      shapeId: createShapeId(pageId),
      width: info.width,
      height: info.height,
      tldrawPageId: placement.tlPageId,
      tldrawPageName: placement.pageName,
      source: info.source,
    })
  }

  console.log(`HTML document ready (${pageInfos.length} pages, ${maps.length} TLDraw pages)`)
  return { name, pages, basePath, format: 'html' }
}
