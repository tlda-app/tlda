/**
 * Maps global page indices (0-based) to their SVG URL paths.
 * Populated by svgLoader for every page; provides the canonical
 * {texBase}-page-{N}.svg filename for any caller that needs to
 * construct history/shadow URLs from a global page index.
 */

const pageUrls = new Map<number, string>()

export function setPageUrl(pageIndex: number, url: string) {
  pageUrls.set(pageIndex, url)
}

export function getPageUrl(pageIndex: number): string | undefined {
  return pageUrls.get(pageIndex)
}

/** Return just the SVG filename (e.g. 'arXiv_v2-page-1.svg') for a 0-based page index. */
export function getPageFilename(pageIndex: number): string | undefined {
  const url = pageUrls.get(pageIndex)
  if (!url) return undefined
  return url.split('/').pop()
}

export function clearPageUrls() {
  pageUrls.clear()
}
