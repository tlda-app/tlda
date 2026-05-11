/**
 * Maps global page indices to their SVG URL paths for multi-target documents.
 * Single-target documents don't populate this — the shape falls back to the flat URL.
 */

const pageUrls = new Map<number, string>()

export function setPageUrl(pageIndex: number, url: string) {
  pageUrls.set(pageIndex, url)
}

export function getPageUrl(pageIndex: number): string | undefined {
  return pageUrls.get(pageIndex)
}

export function clearPageUrls() {
  pageUrls.clear()
}
