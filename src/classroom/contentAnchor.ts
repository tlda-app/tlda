import { htmlIframeElements } from '../htmlIframeRegistry'

/**
 * Where a mark sits in the CONTENT, rather than on the page.
 *
 * A mark on a grading pane is stored in page coordinates, so expanding a
 * collapsed solution moves the student's work out from under it: measured at
 * 577px of shear on one real chapter, with the mark unmoved. The mark keeps its
 * position and loses its meaning, and "a diagonal through a solution says this
 * whole approach is wrong" is the thing that stops being true.
 *
 * So a mark records the content it was drawn over, at BOTH ends. One anchor
 * would translate a diagonal down the page intact while the solution beneath it
 * grew — position preserved, meaning lost again, one level further along. Two
 * anchors let the mark stretch with what it is about.
 *
 * Only the vertical is anchored. The document's layout width is its own
 * (`props.w` on the page shape), and a pane's width reaches the content as a
 * camera `transform: scale()`, which does not reflow a subtree — so text never
 * re-wraps here and `x` needs no anchor. A measurement rather than an argument:
 * a window resize took a pane 676 -> 526 and left a mark's offset at exactly
 * dx302/dy316.
 */
export type ContentAnchor = {
  /** Nearest id-bearing ancestor, then tag-qualified child indices. */
  key: string
  /** Fraction of the anchor element's height, from its top. */
  frac: number
}

export type SpanAnchor = {
  top: ContentAnchor
  bottom: ContentAnchor
}

/**
 * What can carry an anchor. `div.callout-header` earns its place: a callout's
 * two children are its header and its collapse panel, and the container itself
 * has no text of its own, so without the header a mark on a callout's title bar
 * had nothing to anchor to.
 */
const ANCHORABLE = 'p, li, h1, h2, h3, h4, h5, h6, pre, td, th, figure,' +
  ' div.cell-output, div.callout, div.callout-header, svg, img, table'

/**
 * The page's own scripts insert nodes after load — anchorjs into every heading,
 * a copy button into every code block, tooltips onto the body. A plain
 * child-index path does not survive that: on the real chapter, 40 simulated
 * insertions broke 22 of 304 plain keys and none of the tag-qualified ones.
 *
 * `tagName` is deliberately not normalised. HTML reports `DIV` and SVG reports
 * `clipPath`, and lowercasing it broke 17 keys — all of them inside the inline
 * plots, which is also where anchors are sparsest.
 */
export function anchorKey(el: Element, root: Document): string {
  const path: string[] = []
  let node: Element | null = el
  while (node && node !== root.documentElement) {
    if (node.id) return `#${node.id}${path.length ? `/${path.join('/')}` : ''}`
    const parent: Element | null = node.parentElement
    if (!parent) break
    let n = 0
    for (const sibling of parent.children) {
      if (sibling === node) break
      if (sibling.tagName === node.tagName) n++
    }
    path.unshift(`${node.tagName}[${n}]`)
    node = parent
  }
  return `/${path.join('/')}`
}

export function resolveAnchorKey(key: string, root: Document): Element | null {
  const [head, ...steps] = key.split('/')
  let node: Element | null = head.startsWith('#')
    ? root.getElementById(head.slice(1))
    : root.documentElement
  for (const step of steps) {
    if (!node) return null
    const match = /^([A-Za-z0-9:-]+)\[(\d+)\]$/.exec(step)
    if (!match) return null
    let remaining = Number(match[2])
    let found: Element | null = null
    for (const sibling of node.children) {
      if (sibling.tagName !== match[1]) continue
      if (remaining === 0) { found = sibling; break }
      remaining--
    }
    node = found
  }
  return node
}

/**
 * An element that CONTAINS a collapsible cannot carry a fractional offset: its
 * height grows in one place rather than uniformly, so the fraction resolves to
 * somewhere the mark never was. 27 of 304 anchorable elements on the real
 * chapter are such containers.
 */
const containsCollapsible = (el: Element) => !!el.querySelector('.collapse')

/**
 * The deepest anchorable element under a point that is safe to take a fraction
 * of. A collapsed panel has no box at all, which is what makes the descent
 * terminate rather than land inside something invisible.
 */
function anchorElementAt(doc: Document, clientY: number, clientX: number | null): { el: Element; rect: DOMRect } | null {
  let best: { el: Element; rect: DOMRect } | null = null
  for (const el of doc.querySelectorAll(ANCHORABLE)) {
    if (containsCollapsible(el)) continue
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0 || rect.width <= 0) continue
    if (clientY < rect.top || clientY > rect.bottom) continue
    if (clientX !== null && (clientX < rect.left || clientX > rect.right)) continue
    if (!best || rect.height < best.rect.height) best = { el, rect }
  }
  return best
}

export type AnchorContext = {
  doc: Document
  shapeX: number
  shapeY: number
  scale: number
  scrollX: number
  scrollY: number
}

/**
 * Every mounted document for one page shape, not just the registry's entry.
 *
 * `htmlIframeElements` is `Map<string, HTMLIFrameElement>` — one iframe per shape
 * id — and a grading surface mounts the same shape three times (main editor plus
 * two panes). Last writer wins, so the registry names an arbitrary mount. Measured
 * on `replay-a`: the badge rendered into the main editor's copy and was absent
 * from the pane the instructor was looking at, and a mark stayed hidden while the
 * solution it belongs to was open in front of them.
 *
 * The DOM is the source and the registry is a supplement, which is the shape
 * `useMarkedExerciseHtmlAlignment` already uses against the same map.
 */
export type MountedContexts = {
  /** Every mounted document, for work that belongs in all of them (badges). */
  all: AnchorContext[]
  /**
   * The one view that decides placement and hiding, or null.
   *
   * Null has a specific meaning and it is NOT "use another one". When a caller
   * names a governing root, an absent match means that view is not mounted yet —
   * and borrowing a different mount is how a mark ends up hidden because a copy
   * the reader cannot see has a solution closed. The caller must preserve the
   * mark and wait.
   *
   * A caller that names no root is not arbitrating: it gets the registry's
   * context, which is the single-view behaviour that predates this.
   */
  governing: AnchorContext | null
}

export function anchorContexts(
  shape: { id: string; x: number; y: number; props: { w: number } },
  governingRoot?: Element | null,
): MountedContexts {
  const id = String(shape.id)
  const frames = Array.from(
    document.querySelectorAll<HTMLIFrameElement>(`[data-shape-id="${id}"] iframe`),
  )
  const registered = htmlIframeElements.get(id)
  if (registered && !frames.includes(registered)) frames.push(registered)

  const all: AnchorContext[] = []
  const seen = new Set<Document>()
  let governing: AnchorContext | null = null
  for (const frame of frames) {
    const context = contextForDocument(shape, frame.contentDocument)
    if (!context) continue
    // The governing mount is SELECTED, never sorted-to-the-front: a sort puts a
    // match first only when one exists, so with no match the first element is
    // simply an arbitrary mount wearing the governing slot.
    if (governingRoot && !governing && governingRoot.contains(frame)) governing = context
    // One document can back more than one frame element; dedupe on the document
    // so a badge pass does not run twice over the same nodes.
    if (!seen.has(context.doc)) {
      seen.add(context.doc)
      all.push(context)
    }
  }
  // UNDEFINED and NULL are different answers and must not collapse.
  //
  //   undefined  the caller states no policy — it keeps the pre-existing
  //              single-view behaviour rather than silently gaining a choice
  //   null       the caller HAS a policy and its view is not mounted right now,
  //              so there is no governing document and the caller must preserve
  //
  // Written as `=== undefined` rather than `!governingRoot`, which treated an
  // unavailable named view as "no policy" and fell straight back to an arbitrary
  // mount — the defect this whole change exists to remove.
  if (governingRoot === undefined) {
    // The REGISTRY's document and nothing else. A `?? all[0]` tail would hand a
    // caller that stated no policy an arbitrary mount whenever the registry has
    // none — which is not the behaviour that predates this, and is the same
    // arbitrary-mount defect wearing a fallback.
    governing = contextForDocument(shape, htmlIframeElements.get(id)?.contentDocument)
  }
  return { all, governing }
}

/**
 * The page-coordinate mapping the app already uses for html pages, at
 * `src/htmlSelection.ts`. Taken from there rather than re-derived, so a mark and
 * a text selection cannot disagree about where a paragraph is.
 */
export function anchorContext(
  shape: { id: string; x: number; y: number; props: { w: number } },
): AnchorContext | null {
  const iframe = htmlIframeElements.get(String(shape.id))
  return contextForDocument(shape, iframe?.contentDocument ?? null)
}

function contextForDocument(
  shape: { x: number; y: number; props: { w: number } },
  doc: Document | null | undefined,
): AnchorContext | null {
  // A body, not just a document. Every consumer needs one — the MutationObserver
  // observes it, badges are appended inside it, anchors are resolved through it —
  // and an iframe that is still loading has a `documentElement` with no `body`.
  //
  // This only became reachable when mounts started being enumerated from the DOM:
  // before, the single registry document was always a loaded one. Measured as a
  // crash, not deduced — `observe(null)` threw `parameter 1 is not of type 'Node'`
  // and took the whole grading surface to its error boundary.
  if (!doc?.body) return null
  // A width of zero means the document has not laid out yet, which is a
  // different thing from a narrow document. Falling back to a default here
  // produced a plausible scale from a page that had no geometry, and an anchor
  // recorded in that window would be wrong in a way nothing later corrects.
  //
  // `documentElement` is deliberately NOT part of this maximum any more: it
  // reports a width for a document whose body has not arrived, which is exactly
  // the case the guard above now rejects.
  const documentWidth = doc.body.scrollWidth || 0
  if (documentWidth <= 0) return null
  return {
    doc,
    shapeX: shape.x,
    shapeY: shape.y,
    scale: shape.props.w / documentWidth,
    scrollX: doc.defaultView?.scrollX || 0,
    scrollY: doc.defaultView?.scrollY || 0,
  }
}

const toPageY = (c: AnchorContext, clientY: number) => c.shapeY + (clientY + c.scrollY) * c.scale
const toClientY = (c: AnchorContext, pageY: number) => (pageY - c.shapeY) / c.scale - c.scrollY

export function anchorAt(c: AnchorContext, pageY: number, pageX: number | null = null): ContentAnchor | null {
  const clientY = toClientY(c, pageY)
  const clientX = pageX === null ? null : (pageX - c.shapeX) / c.scale - c.scrollX
  const hit = anchorElementAt(c.doc, clientY, clientX)
  if (!hit) return null
  return {
    key: anchorKey(hit.el, c.doc),
    frac: hit.rect.height > 0 ? (clientY - hit.rect.top) / hit.rect.height : 0,
  }
}

/**
 * `null` means the anchored content is not laid out — its solution is collapsed.
 * The caller must HIDE the mark rather than fall back to a nearby position:
 * painting a diagonal onto a callout's title bar puts it somewhere it was never
 * drawn, which is the same loss of meaning the anchor exists to prevent.
 *
 * Skip settled the behaviour directly: "the marking stuff is only visible when
 * things are expanded".
 *
 * He settled a second half in the same breath — "we.can like badge them", a mark
 * on the collapsed solution so a student can see there is feedback inside
 * without opening it. **That half is NOT built.** As things stand a student's
 * feedback can be entirely invisible with nothing saying it exists, which is a
 * worse state than either end of his ruling. Said here rather than left implied,
 * because this comment used to cite the badge as though the code did it.
 */
export function anchorPageY(c: AnchorContext, anchor: ContentAnchor): number | null {
  const el = resolveAnchorKey(anchor.key, c.doc)
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (rect.height <= 0 && rect.width <= 0) return null
  return toPageY(c, rect.top + anchor.frac * rect.height)
}

/** Both ends, or nothing: a span that resolves at one end has lost its meaning. */
export function spanAnchorFor(c: AnchorContext, topPageY: number, bottomPageY: number): SpanAnchor | null {
  const top = anchorAt(c, topPageY)
  const bottom = anchorAt(c, bottomPageY)
  return top && bottom ? { top, bottom } : null
}

export function spanPageY(c: AnchorContext, span: SpanAnchor): { top: number; bottom: number } | null {
  const top = anchorPageY(c, span.top)
  const bottom = anchorPageY(c, span.bottom)
  return top === null || bottom === null ? null : { top, bottom }
}
