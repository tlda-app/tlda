/**
 * Per-page "render hash": the build hash each page was last RENDERED at in THIS
 * viewer, keyed by page shape id, plus the latest known built page count.
 *
 * This is per-VIEWER state — every viewer has its own camera and its own lazy-
 * load progress — so it is deliberately client-local and never synced. Used to
 * detect when Displayed has drifted from Built:
 *   - stale pixels:   a visible page whose render hash != the sentinel's build hash
 *   - phantom page:   a page past the built page count (doc got shorter)
 *   - missing page:   a built page not yet laid out (doc got longer)
 *
 * The version stamp on a chat is always Built (the sentinel); this store only
 * feeds the *exceptional* staleness flag on the location, never the version.
 */

const renderHashes = new Map<string, string>()
let builtPageCount: number | null = null

/** Record the build hash a page shape was rendered at (short hash). */
export function setPageRenderHash(shapeId: string, hash: string) {
  renderHashes.set(shapeId, hash)
}

/** The build hash a page shape currently shows, or undefined if never rendered here. */
export function getPageRenderHash(shapeId: string): string | undefined {
  return renderHashes.get(shapeId)
}

/** Record the page count of the latest build (from the project API / reload). */
export function setBuiltPageCount(count: number) {
  builtPageCount = count
}

export function getBuiltPageCount(): number | null {
  return builtPageCount
}

export function clearRenderHashes() {
  renderHashes.clear()
  builtPageCount = null
}
