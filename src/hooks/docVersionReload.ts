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
