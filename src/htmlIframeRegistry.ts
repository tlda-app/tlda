export const htmlIframeElements = new Map<string, HTMLIFrameElement>()

/**
 * The completion half of the html-page reload: which document a shape's iframe
 * has actually finished loading, and who is waiting for a particular one.
 *
 * The reload path has to attach its listener BEFORE it mutates the url, or the
 * load fires unobserved; but an element listener alone cannot tell a caller that
 * *its* navigation finished. Two ways that goes wrong, both observed or reachable:
 * the listener waits out a timeout for a load that already happened, and an
 * earlier navigation's load satisfies a later reload's wait.
 *
 * So completion is keyed to the requested URL rather than to an element or a
 * count. A count proves another load happened; it does not prove the requested
 * document is the one now in the frame.
 *
 * This is the existing reload path's completion contract — `handleIframeLoad`
 * already knew all of this and discarded it — not a second registry and not a
 * retry service. Nothing here polls.
 */
type LoadWaiter = { url: string; settle: (loaded: boolean) => void }

const lastLoadedUrl = new Map<string, string>()
const loadWaiters = new Map<string, Set<LoadWaiter>>()

/**
 * What identifies "this reload" in a URL: the path, plus the `_tldaReload` token
 * the reload itself set.
 *
 * Full-string equality does NOT work, and this is measured rather than assumed.
 * On a real reload the requested url and the loaded document differ:
 *
 *   requested   .../week1-homework.html?_tldaReload=1789381083230
 *   loaded      .../week1-homework.html?_tldaReload=1789381083230&_tldaShape=shape:qmd-anchor-page-0
 *
 * The rendered `src` carries a `_tldaShape` parameter the reload never asked
 * for, so comparing whole strings never matches and every wait would fall
 * through to its timeout — a notification that silently never notifies.
 *
 * The reload token is the right key because the reload is what sets it: it is
 * unique per reload, survives into the loaded document, and is unaffected by
 * parameters appended elsewhere or by query re-encoding.
 */
function reloadToken(url: string): { path: string; token: string } | null {
  try {
    // The base only matters for parsing a relative url; the origin is not compared.
    const parsed = new URL(url, 'https://html-page.invalid')
    const token = parsed.searchParams.get('_tldaReload')
    return token ? { path: parsed.pathname, token } : null
  } catch {
    return null
  }
}

/**
 * Is the loaded document the one this wait asked for?
 *
 * Compares reload tokens when both carry one — every reload does, because
 * `htmlPageReloadUrl` always sets it. With no token there is nothing safer than
 * exact equality: two different documents on one path would otherwise look
 * identical, which is a false match rather than a missed one.
 */
function sameReload(requested: string, loaded: string): boolean {
  const a = reloadToken(requested)
  const b = reloadToken(loaded)
  if (!a || !b) return requested === loaded
  return a.path === b.path && a.token === b.token
}

/** The document the frame actually holds, which is not always `src` after a navigation. */
function loadedUrl(iframe: HTMLIFrameElement): string {
  try {
    return iframe.contentWindow?.location?.href || iframe.src || ''
  } catch {
    // Cross-origin frames throw on location access; `src` is what we asked for.
    return iframe.src || ''
  }
}

/**
 * Record that this shape's iframe finished loading, and release anyone waiting
 * for that particular document. Called from the iframe's own `load` handler.
 */
export function noteHtmlIframeLoaded(shapeId: string, iframe: HTMLIFrameElement) {
  htmlIframeElements.set(shapeId, iframe)
  const url = loadedUrl(iframe)
  lastLoadedUrl.set(shapeId, url)

  const waiters = loadWaiters.get(shapeId)
  if (!waiters) return
  for (const waiter of [...waiters]) {
    // An empty `url` means "any load for this shape"; a set one must match, so a
    // stale navigation cannot satisfy a later reload.
    if (waiter.url && !sameReload(waiter.url, url)) continue
    waiters.delete(waiter)
    waiter.settle(true)
  }
  if (waiters.size === 0) loadWaiters.delete(shapeId)
}

/**
 * Resolve when this shape's iframe has loaded `url`.
 *
 * Resolves IMMEDIATELY if that document is already the loaded one — the
 * already-fired case, which a listener attached afterwards would otherwise sit
 * out. `dispose` removes the waiter; the caller must call it on every exit,
 * including its own timeout, or a waiter outlives the reload that made it.
 */
export function whenHtmlIframeLoaded(shapeId: string, url: string): { loaded: Promise<boolean>; dispose: () => void } {
  const alreadyLoaded = lastLoadedUrl.get(shapeId)
  if (url && alreadyLoaded && sameReload(url, alreadyLoaded)) {
    return { loaded: Promise.resolve(true), dispose: () => {} }
  }

  let waiter: LoadWaiter | null = null
  const loaded = new Promise<boolean>(settle => {
    waiter = { url, settle }
    let waiters = loadWaiters.get(shapeId)
    if (!waiters) {
      waiters = new Set<LoadWaiter>()
      loadWaiters.set(shapeId, waiters)
    }
    waiters.add(waiter)
  })

  return {
    loaded,
    dispose() {
      const waiters = loadWaiters.get(shapeId)
      if (!waiters || !waiter) return
      waiters.delete(waiter)
      // Settle as NOT loaded so nothing awaiting it hangs, and so a caller
      // cannot mistake being cancelled for the document arriving.
      waiter.settle(false)
      if (waiters.size === 0) loadWaiters.delete(shapeId)
    },
  }
}

/** Drop everything held for a shape that is gone, so no waiter outlives it. */
export function disposeHtmlIframeLoadWaiters(shapeId: string) {
  const waiters = loadWaiters.get(shapeId)
  // Settle FALSE: the shape is gone, so no document arrived. Resolving these as
  // though they had loaded made a shape deletion look like a completed reload,
  // and the caller remapped on it.
  if (waiters) for (const waiter of [...waiters]) waiter.settle(false)
  loadWaiters.delete(shapeId)
  lastLoadedUrl.delete(shapeId)
}

/** Test seam: the waiter count for a shape, so disposal can be asserted rather than assumed. */
export function htmlIframeLoadWaiterCount(shapeId: string): number {
  return loadWaiters.get(shapeId)?.size ?? 0
}
