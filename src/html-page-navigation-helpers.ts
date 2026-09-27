/**
 * How long a link navigation waits for the target chapter's anchor positions
 * after switching to it. A cold chapter iframe takes far longer than feels
 * reasonable to load and report (measured: chapter-comparing-two-groups took
 * 27.8s from click to first positions on testing over tailscale), so anything
 * under that strands the reader at the top of the chapter on a slow load.
 */
export const ANCHOR_RESOLVE_TIMEOUT_MS = 60000

export function htmlPageReloadUrl(url: string, timestamp: number) {
  const [base, hash = ''] = url.split('#', 2)
  const [path, query = ''] = base.split('?', 2)
  const params = new URLSearchParams(query)
  params.set('_tldaReload', String(timestamp))
  const next = `${path}?${params.toString()}`
  return hash ? `${next}#${hash}` : next
}

export function htmlPageFileFromUrl(url: string, basePath: string, locationHref = window.location.href) {
  const baseUrl = new URL(basePath, locationHref)
  const pageUrl = new URL(url, locationHref)
  if (pageUrl.origin === baseUrl.origin && pageUrl.pathname.startsWith(baseUrl.pathname)) {
    return decodeURIComponent(pageUrl.pathname.slice(baseUrl.pathname.length))
  }
  return decodeURIComponent(pageUrl.pathname.replace(/^\/+/, ''))
}

export function htmlPageUrlMatchesTargetFile(url: string, targetFile: string) {
  const cleanUrl = String(url || '').split('#', 1)[0].split('?', 1)[0]
  const cleanTarget = String(targetFile || '').replace(/^\.?\//, '').split('#', 1)[0].split('?', 1)[0]
  if (!cleanUrl || !cleanTarget) return false
  // Quarto authors link chapters as `.qmd` and the built book keeps some of
  // those hrefs (measured: the course index links `chapter-bootstrap-slides.qmd`
  // while the shape serves its `.html`). Without this mapping the click matches
  // nothing and dies silently.
  const targetCandidates = new Set([
    cleanTarget,
    cleanTarget.replace(/\.(md|markdown|qmd)$/i, '.html'),
    cleanTarget.replace(/^.*\//, ''),
    cleanTarget.replace(/^.*\//, '').replace(/\.(md|markdown|qmd)$/i, '.html'),
  ])
  for (const candidate of targetCandidates) {
    if (!candidate) continue
    if (cleanUrl.endsWith('/' + candidate)) return true
    if (cleanUrl.includes('/' + candidate + '/')) return true
  }
  return false
}

export type NavigateTargetShape = {
  id: string
  props?: { url?: string }
}

/**
 * Which canvas shape a `tlda-navigate` message names: by served URL when the
 * link carries a file, by id for a same-page anchor. Null when nothing matches,
 * which the caller reports loudly rather than dropping.
 *
 * Resolution consults only the addressed target — never another shape's anchor
 * positions. A previous fallback re-targeted to whichever loaded shape held a
 * same-named anchor when the addressed chapter's positions were not yet reported
 * (measured: a Figure 29.1 click bound for chapter-comparing-two-groups landed on
 * chapter-social-pressure-experiment instead, with no page switch). Positions for
 * an unloaded chapter arrive when its iframe mounts after the switch, which the
 * caller's poll already covers.
 */
export function findNavigateTargetShape(
  shapes: readonly NavigateTargetShape[],
  targetFile: string | null | undefined,
  shapeId: string | null | undefined,
): NavigateTargetShape | null {
  if (targetFile) {
    return shapes.find(s => htmlPageUrlMatchesTargetFile(s.props?.url || '', targetFile)) ?? null
  }
  if (!shapeId) return null
  return shapes.find(s => s.id === shapeId) ?? null
}

export type PageBoundsLike = { x: number; y: number; w: number; h: number }

/**
 * Whether a docview sits in the reader's visible layout: within a page of the
 * document in every direction. A margin panel qualifies however the camera is
 * placed — scrolled just out of view is still the layout being worked in — and
 * a shape 24,000 units from the document does not (measured: clicks wrote there
 * and returned with no motion, no history, no error). Deliberately
 * camera-independent: membership must not flip as the reader scrolls.
 */
export function docviewInLayoutExtent(doc: PageBoundsLike, dv: PageBoundsLike): boolean {
  const ex = { x: doc.x - doc.w, y: doc.y - doc.h, w: doc.w * 3, h: doc.h * 3 }
  return dv.x < ex.x + ex.w && dv.x + dv.w > ex.x
    && dv.y < ex.y + ex.h && dv.y + dv.h > ex.y
}

export type LinkPeekState = {
  pageId: string
  /** Target shape plus anchor: `shape:book-page-1::fig-neighbors-letter`. */
  key: string
  touched: boolean
}

/**
 * The link-click contract: the first click peeks the target into the reader's
 * layout docview; a second click on the same link, with nothing done in the
 * docview in between, commits and navigates the main view. The tracker holds
 * the last peek; the caller reports docview interaction (pointer or wheel
 * inside the docview) via noteTouch.
 */
export function createLinkPeekTracker() {
  let last: LinkPeekState | null = null
  return {
    recordPeek(pageId: string, key: string) {
      last = { pageId, key, touched: false }
    },
    noteTouch() {
      if (last) last.touched = true
    },
    /** True when this click repeats the last peek on the same page untouched. */
    shouldCommit(pageId: string, key: string): boolean {
      return !!last && !last.touched && last.pageId === pageId && last.key === key
    },
    clear() {
      last = null
    },
  }
}

export type LinkPeekTracker = ReturnType<typeof createLinkPeekTracker>
