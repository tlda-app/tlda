// Static synctex lookup (for hosted deployments)
// Falls back to server-based lookup for local development

import type { SourceAnchor, PdfPosition } from './synctexAnchor'

// Derive HTTP base from VITE_SYNC_SERVER for cross-origin deployments
// (SPA on GitHub Pages, assets on Fly.io). Same-origin: returns BASE_URL.
function assetBase(): string {
  const ws = import.meta.env.VITE_SYNC_SERVER as string | undefined
  if (ws) return ws.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '') + '/'
  return import.meta.env.BASE_URL || '/'
}

export interface LookupEntry {
  page: number
  x: number
  y: number
  content: string
}

export interface LookupData {
  meta: {
    texFile: string
    generated: string
    totalLines: number
    inputFiles?: string[]
    appendixLine?: { line: number; file?: string }
  }
  lines: Record<string, LookupEntry>
}

// Cache loaded lookup tables
const lookupCache = new Map<string, LookupData | null>()

/**
 * Load lookup table for a document
 */
export async function loadLookup(docName: string): Promise<LookupData | null> {
  if (lookupCache.has(docName)) {
    const cached = lookupCache.get(docName)!
    console.log(`[SyncTeX] loadLookup cache hit for ${docName}:`, !!cached)
    return cached
  }

  try {
    const base = assetBase()
    const resp = await fetch(`${base}docs/${docName}/lookup.json?t=${Date.now()}`)
    if (!resp.ok) {
      lookupCache.set(docName, null)
      return null
    }
    const data = await resp.json()
    lookupCache.set(docName, data)
    return data
  } catch (e) {
    console.warn(`[SyncTeX] Could not load lookup.json for ${docName}`)
    lookupCache.set(docName, null)
    return null
  }
}

/**
 * Check if static lookup is available for a document
 */
export async function hasStaticLookup(docName: string): Promise<boolean> {
  const lookup = await loadLookup(docName)
  return lookup !== null
}

/**
 * Find source anchor for PDF position using static lookup
 * Returns null if no lookup available (caller should fall back to server)
 */
export async function getSourceAnchorStatic(
  docName: string,
  page: number,
  _x: number,
  _y: number
): Promise<SourceAnchor | null> {
  const lookup = await loadLookup(docName)
  if (!lookup) return null

  // Find lines on this page AND adjacent pages (synctex page boundaries
  // don't always match rendered page boundaries — content near the bottom
  // of rendered page N may be mapped to synctex page N+1).
  // Keys may be "42" (main file) or "appendix.tex:42" (input file)
  const candidates: Array<{ line: number; file: string; entry: LookupEntry; pageOffset: number }> = []
  for (const [key, entry] of Object.entries(lookup.lines)) {
    const pageOffset = entry.page - page
    if (pageOffset < -1 || pageOffset > 1) continue // only this page ± 1
    const colonIdx = key.indexOf(':')
    const file = colonIdx >= 0 ? `./${key.slice(0, colonIdx)}` : `./${lookup.meta?.texFile ?? ''}`
    const line = colonIdx >= 0 ? parseInt(key.slice(colonIdx + 1)) : parseInt(key)
    candidates.push({ line, file, entry, pageOffset })
  }

  if (candidates.length === 0) return null

  // For lines on this page: match by y distance.
  // For lines on adjacent pages: they're candidates only if nothing on
  // this page is close (within 50 PDF points). Adjacent page lines use
  // a penalty to prefer same-page matches.
  const thisPage = candidates.filter(c => c.pageOffset === 0)
  const ADJACENT_PENALTY = 100 // PDF points — prefer same-page

  let closest = candidates[0]
  let minDist = Infinity
  for (const item of candidates) {
    const dist = Math.abs(_y - item.entry.y) + (item.pageOffset !== 0 ? ADJACENT_PENALTY : 0)
    if (dist < minDist) {
      minDist = dist
      closest = item
    }
  }

  // If we picked an adjacent page line, check if the y position is near
  // the page edge (top 50pt for prev page, bottom 50pt for next page)
  if (closest.pageOffset !== 0 && thisPage.length > 0) {
    const bestThisPage = thisPage.reduce((a, b) =>
      Math.abs(_y - a.entry.y) < Math.abs(_y - b.entry.y) ? a : b)
    // Only use adjacent if the this-page match is very far (>200pt)
    if (Math.abs(_y - bestThisPage.entry.y) < 200) {
      closest = bestThisPage
    }
  }

  return {
    file: closest.file,
    line: closest.line,
    content: closest.entry.content
  }
}

/**
 * Resolve anchor to PDF position using static lookup
 * Returns null if no lookup available (caller should fall back to server)
 */
export async function resolveAnchorStatic(
  docName: string,
  anchor: SourceAnchor
): Promise<PdfPosition | null> {
  const lookup = await loadLookup(docName)
  if (!lookup) return null

  let resolvedLine = anchor.line

  // If we have content, search for it
  if (anchor.content) {
    const searchContent = anchor.content
    let bestMatch: { line: number; distance: number } | null = null

    for (const [lineStr, entry] of Object.entries(lookup.lines)) {
      const lineNum = parseInt(lineStr)
      // Check if content matches (exact substring)
      if (entry.content.includes(searchContent) || searchContent.includes(entry.content)) {
        const distance = Math.abs(lineNum - anchor.line)
        if (!bestMatch || distance < bestMatch.distance) {
          bestMatch = { line: lineNum, distance }
        }
      }
    }

    // Also try normalized match (collapse whitespace)
    if (!bestMatch) {
      const normalizedSearch = searchContent.replace(/\s+/g, ' ').trim()
      for (const [lineStr, entry] of Object.entries(lookup.lines)) {
        const lineNum = parseInt(lineStr)
        const normalizedContent = entry.content.replace(/\s+/g, ' ').trim()
        if (normalizedContent.includes(normalizedSearch) || normalizedSearch.includes(normalizedContent)) {
          const distance = Math.abs(lineNum - anchor.line)
          if (!bestMatch || distance < bestMatch.distance) {
            bestMatch = { line: lineNum, distance }
          }
        }
      }
    }

    if (bestMatch) {
      if (bestMatch.line !== anchor.line) {
        console.log(`[SyncTeX] Content found at line ${bestMatch.line} (was ${anchor.line})`)
      }
      resolvedLine = bestMatch.line
    } else {
      console.warn(`[SyncTeX] Content not found in lookup, using original line ${anchor.line}`)
    }
  }

  // Determine lookup key — use "file:line" for input files, plain line for main file
  const anchorFile = anchor.file?.replace(/^\.\//, '')
  const isInputFile = anchorFile && lookup.meta.inputFiles?.includes(anchorFile)
  const keyPrefix = isInputFile ? `${anchorFile}:` : ''

  // Look up the resolved line
  const entry = lookup.lines[`${keyPrefix}${resolvedLine}`]
  if (!entry) {
    // Try nearby lines
    for (let offset = 1; offset <= 5; offset++) {
      const nearby = lookup.lines[`${keyPrefix}${resolvedLine + offset}`] ||
                     lookup.lines[`${keyPrefix}${resolvedLine - offset}`]
      if (nearby) {
        return { page: nearby.page, x: nearby.x, y: nearby.y }
      }
    }
    console.warn(`[SyncTeX] Line ${resolvedLine} not in lookup`)
    return null
  }

  return { page: entry.page, x: entry.x, y: entry.y }
}

export interface ReverseMatch {
  file: string   // relative filename (e.g. "appendix.tex") or main file
  line: number
}

/**
 * Build a reverse synctex index: given a page and y-coordinate, find the
 * closest source line and file. Returns a function that does the lookup.
 */
export async function buildReverseIndex(docName: string): Promise<((page: number, y: number) => ReverseMatch | null) | null> {
  const lookup = await loadLookup(docName)
  if (!lookup) return null

  const mainFile = lookup.meta?.texFile ?? ''

  // Group entries by page, sorted by y
  // For keys like "file.tex:42", extract the file and line portions
  const byPage = new Map<number, { y: number; line: number; file: string }[]>()
  for (const [key, entry] of Object.entries(lookup.lines)) {
    const colonIdx = key.indexOf(':')
    let file: string, line: number
    if (colonIdx >= 0) {
      file = key.slice(0, colonIdx)
      line = parseInt(key.slice(colonIdx + 1))
    } else {
      file = mainFile
      line = parseInt(key)
    }
    if (!byPage.has(entry.page)) byPage.set(entry.page, [])
    byPage.get(entry.page)!.push({ y: entry.y, line, file })
  }
  for (const entries of byPage.values()) {
    entries.sort((a, b) => a.y - b.y)
  }

  return (page: number, y: number): ReverseMatch | null => {
    const entries = byPage.get(page)
    if (!entries || entries.length === 0) return null

    // Binary search for closest y
    let lo = 0, hi = entries.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (entries[mid].y < y) lo = mid + 1
      else hi = mid
    }
    // Check lo and lo-1 for closest
    let best = lo
    if (lo > 0 && Math.abs(entries[lo - 1].y - y) < Math.abs(entries[lo].y - y)) {
      best = lo - 1
    }
    // Only match if within ~30pt (about 2 lines of text)
    if (Math.abs(entries[best].y - y) > 30) return null
    return { file: entries[best].file, line: entries[best].line }
  }
}

/**
 * Clear lookup cache (call after document rebuild)
 */
export function clearLookupCache(docName?: string) {
  if (docName) {
    lookupCache.delete(docName)
    htmlTocCache.delete(docName)
    htmlSearchCache.delete(docName)
  } else {
    lookupCache.clear()
    htmlTocCache.clear()
    htmlSearchCache.clear()
  }
}

// --- HTML document TOC and search ---

export interface HtmlTocEntry {
  title: string
  level: 'part' | 'chapter' | 'section' | 'subsection' | 'subsubsection'
  page: number
  anchor?: string
  targetFile?: string  // book cross-member navigation: member key
}

export interface HtmlSearchEntry {
  page: number
  text: string
  label?: string
  anchor?: string
}

const htmlTocCache = new Map<string, HtmlTocEntry[] | null>()
const htmlSearchCache = new Map<string, HtmlSearchEntry[] | null>()

export async function loadHtmlToc(docName: string): Promise<HtmlTocEntry[] | null> {
  if (htmlTocCache.has(docName)) return htmlTocCache.get(docName)!
  try {
    const base = assetBase()
    const resp = await fetch(`${base}docs/${docName}/toc.json`)
    if (!resp.ok) { htmlTocCache.set(docName, null); return null }
    const data = await resp.json()
    htmlTocCache.set(docName, data)
    return data
  } catch {
    htmlTocCache.set(docName, null)
    return null
  }
}

export async function loadHtmlSearch(docName: string): Promise<HtmlSearchEntry[] | null> {
  if (htmlSearchCache.has(docName)) return htmlSearchCache.get(docName)!
  try {
    const base = assetBase()
    const resp = await fetch(`${base}docs/${docName}/search-index.json`)
    if (!resp.ok) { htmlSearchCache.set(docName, null); return null }
    const data = await resp.json()
    htmlSearchCache.set(docName, data)
    return data
  } catch {
    htmlSearchCache.set(docName, null)
    return null
  }
}
