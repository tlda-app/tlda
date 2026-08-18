export type RenderedPage = { shapeId: string }

type DocVersionReloadObserverOptions = {
  readHash: () => string | null
  hasMismatchedRender: (hash: string) => boolean
  reload: () => void
}

export function docVersionHashFromRecord(record: unknown): string | null {
  const hash = (record as { props?: { commitHash?: unknown } } | null)?.props?.commitHash
  return typeof hash === 'string' && hash !== 'unknown' && hash.length > 0 ? hash : null
}

export function hasRenderedPageMismatch(
  pages: RenderedPage[],
  buildHash: string,
  getSvgText: (shapeId: string) => string | undefined,
  getPageRenderHash: (shapeId: string) => string | undefined,
): boolean {
  const shortHash = buildHash.slice(0, 7)
  return pages.some(page => getSvgText(page.shapeId) !== undefined && getPageRenderHash(page.shapeId) !== shortHash)
}

/**
 * `hadPreviousHash` is load-bearing and it is not a missing-null-check. Do not
 * "fix" it by firing on the first advance.
 *
 * The observer is installed from SvgDocument's onMount. @tldraw/sync only ever
 * reports `loading` then `synced-remote` (useSync gates on readyClient), and
 * TldrawEditor does not create the Editor at all while the status is `loading`
 * — so by the time onMount runs, the room's shapes are already in the store and
 * this first `readHash()` sees the real sentinel. Dropping the guard would
 * therefore not catch a missed refresh; it would fire a full document reload
 * every time anyone opens a document.
 *
 * The one case where this reads null is a sentinel whose commitHash is the
 * literal 'unknown' — build-runner writes `shadowHash || 'unknown'`, and
 * docVersionHashFromRecord maps that to null — which happens when a project's
 * shadow has no commit yet. That costs one missed refresh and heals itself: the
 * swallowed advance sets previousHash, so the next build's advance fires.
 *
 * Checked 2026-08-18, when a render going backwards looked like it might be a
 * swallowed refresh. It wasn't — that was out-of-order build publishing, fixed
 * separately in build-runner.
 */
export function createDocVersionReloadObserver({
  readHash,
  hasMismatchedRender,
  reload,
}: DocVersionReloadObserverOptions): () => void {
  let previousHash = readHash()

  return () => {
    const nextHash = readHash()
    if (!nextHash || nextHash === previousHash) return
    const hadPreviousHash = previousHash !== null
    previousHash = nextHash
    if (hadPreviousHash && hasMismatchedRender(nextHash)) reload()
  }
}
