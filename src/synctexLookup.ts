// Static synctex lookup (for hosted deployments)
// Falls back to server-based lookup for local development

import type { SourceAnchor, PdfPosition } from './synctexAnchor'
import { onReloadSignal } from './useYjsSync'
import { STORE_HTTP } from './activeConfig'

// Doc assets come from the active config's STORE (http), injected by the server.
function assetBase(): string {
  return STORE_HTTP + '/'
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

// Promise cache: concurrent first-callers share one in-flight request
const lookupCache = new Map<string, Promise<LookupData | null>>()

/**
 * Load lookup table for a document. Results are cached for the session;
 * concurrent callers share one fetch rather than each issuing their own.
 */
export function loadLookup(projectName: string): Promise<LookupData | null> {
  if (!lookupCache.has(projectName)) {
    const base = assetBase()
    lookupCache.set(projectName, fetch(`${base}docs/${projectName}/lookup.json`)
      .then(resp => {
        if (!resp.ok) return null
        return resp.json() as Promise<LookupData>
      })
      .catch(() => {
        console.warn(`[SyncTeX] Could not load lookup.json for ${projectName}`)
        return null
      })
    )
  }
  return lookupCache.get(projectName)!
}

/**
 * Check if static lookup is available for a document
 */
export async function hasStaticLookup(projectName: string): Promise<boolean> {
  const lookup = await loadLookup(projectName)
  return lookup !== null
}

/**
 * Find source anchor for PDF position using static lookup
 * Returns null if no lookup available (caller should fall back to server)
 */
export async function getSourceAnchorStatic(
  projectName: string,
  page: number,
  _x: number,
  _y: number
): Promise<SourceAnchor | null> {
  const lookup = await loadLookup(projectName)
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
  projectName: string,
  anchor: SourceAnchor
): Promise<PdfPosition | null> {
  const lookup = await loadLookup(projectName)
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

/**
 * Clear lookup cache (call after document rebuild)
 */
export function clearLookupCache(projectName?: string) {
  if (projectName) {
    lookupCache.delete(projectName)
    htmlTocCache.delete(projectName)
    htmlSearchCache.delete(projectName)
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

// Clear all doc-asset caches on LaTeX rebuild so fresh output is loaded
onReloadSignal(() => {
  lookupCache.clear()
  htmlTocCache.clear()
  htmlSearchCache.clear()
})

export async function loadHtmlToc(projectName: string): Promise<HtmlTocEntry[] | null> {
  if (htmlTocCache.has(projectName)) return htmlTocCache.get(projectName)!
  try {
    const base = assetBase()
    const resp = await fetch(`${base}docs/${projectName}/toc.json`)
    if (!resp.ok) { htmlTocCache.set(projectName, null); return null }
    const data = await resp.json()
    htmlTocCache.set(projectName, data)
    return data
  } catch {
    htmlTocCache.set(projectName, null)
    return null
  }
}

export async function loadHtmlSearch(projectName: string): Promise<HtmlSearchEntry[] | null> {
  if (htmlSearchCache.has(projectName)) return htmlSearchCache.get(projectName)!
  try {
    const base = assetBase()
    const resp = await fetch(`${base}docs/${projectName}/search-index.json`)
    if (!resp.ok) { htmlSearchCache.set(projectName, null); return null }
    const data = await resp.json()
    htmlSearchCache.set(projectName, data)
    return data
  } catch {
    htmlSearchCache.set(projectName, null)
    return null
  }
}
