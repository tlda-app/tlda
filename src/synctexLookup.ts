// Static synctex lookup (for hosted deployments)
// Falls back to server-based lookup for local development

import type { SourceAnchor, PdfPosition } from './synctexAnchor'

interface LookupEntry {
  page: number
  x: number
  y: number
  content: string
}

interface LookupData {
  meta: {
    texFile: string
    generated: string
    totalLines: number
  }
  lines: Record<string, LookupEntry>
}

// Cache loaded lookup tables
const lookupCache = new Map<string, LookupData | null>()

/**
 * Load lookup table for a document
 */
async function loadLookup(docName: string): Promise<LookupData | null> {
  if (lookupCache.has(docName)) {
    return lookupCache.get(docName)!
  }

  try {
    const resp = await fetch(`/docs/${docName}/lookup.json`)
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

  // Find lines on this page, sorted by y position
  const linesOnPage: Array<{ line: number; entry: LookupEntry }> = []
  for (const [lineStr, entry] of Object.entries(lookup.lines)) {
    if (entry.page === page) {
      linesOnPage.push({ line: parseInt(lineStr), entry })
    }
  }

  if (linesOnPage.length === 0) return null

  // Sort by y, then by line number
  linesOnPage.sort((a, b) => a.entry.y - b.entry.y || a.line - b.line)

  // Find closest line to click position
  // For now, just return the line with closest y
  // TODO: improve with x proximity
  let closest = linesOnPage[0]
  let minDist = Math.abs(_y - closest.entry.y)
  for (const item of linesOnPage) {
    const dist = Math.abs(_y - item.entry.y)
    if (dist < minDist) {
      minDist = dist
      closest = item
    }
  }

  return {
    file: `./${lookup.meta.texFile}`,
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

  // Look up the resolved line
  const entry = lookup.lines[resolvedLine.toString()]
  if (!entry) {
    // Try nearby lines
    for (let offset = 1; offset <= 5; offset++) {
      const nearby = lookup.lines[(resolvedLine + offset).toString()] ||
                     lookup.lines[(resolvedLine - offset).toString()]
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
export function clearLookupCache(docName?: string) {
  if (docName) {
    lookupCache.delete(docName)
  } else {
    lookupCache.clear()
  }
}
