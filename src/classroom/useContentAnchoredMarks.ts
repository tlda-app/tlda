import { useEffect } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { anchorContext, anchorContexts, resolveAnchorKey, spanAnchorFor, spanPageY, type AnchorContext, type SpanAnchor } from './contentAnchor'

/**
 * Marks a badge element so the observer can ignore its own writes. Without this
 * the badge is a document mutation, the observer schedules a placement, the
 * placement rewrites the badge, and the loop never settles.
 */
const BADGE_ATTR = 'data-tlda-feedback-badge'

const isBadge = (node: Node | null): boolean =>
  !!node && node.nodeType === 1 && (node as Element).hasAttribute?.(BADGE_ATTR)

/**
 * Whether a batch of mutations is only this hook writing its own badges.
 *
 * Exported because it is the dangerous half of the badge. Too loose and the
 * badge retriggers the placement that wrote it, forever; too tight and it
 * swallows real reflows, which is the trigger defect this hook already had once.
 *
 * The first version was too tight in exactly the way that is hard to see: it
 * fell through to `[...addedNodes, ...removedNodes].every(isBadge)` for ANY
 * record, and an **attribute** record — a `.collapse` class toggling, the main
 * reflow this hook exists for — carries EMPTY node lists, so `every` was
 * vacuously true and the reflow was discarded as "ours".
 */
export function isOwnBadgeWrite(records: MutationRecord[]): boolean {
  if (records.length === 0) return false
  return records.every(record => {
    const target = record.target as Element
    if (isBadge(target) || (target?.nodeType === 1 && target.closest?.(`[${BADGE_ATTR}]`))) return true
    // Only a childList record can be ours by its nodes, and only if there ARE
    // nodes — an empty list must never pass.
    if (record.type !== 'childList') return false
    const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]
    return nodes.length > 0 && nodes.every(isBadge)
  })
}

/**
 * Say that a closed solution is hiding feedback.
 *
 * Skip settled both halves in one breath: "the markinf sruff is onky visible
 * when things are expanded" and "we.can like badge them". Hiding alone leaves a
 * student looking at work that appears unmarked, which is worse than either end
 * of what he asked for.
 *
 * Written into the document rather than drawn on the canvas because the thing it
 * labels — a collapsed callout — lives in the iframe, and it is per-view by
 * construction: this document is never synced, so no badge state is stored and
 * nothing about it can reach another reader.
 */
export function renderFeedbackBadges(doc: Document, hidden: Map<Element, Set<string>>) {
  const wanted = new Map<Element, number>()
  for (const [panel, marks] of hidden) {
    // The header is what stays visible when the panel is closed, so it is where
    // a badge can actually be seen.
    const header = panel.closest('.callout')?.querySelector('.callout-header')
    if (header) wanted.set(header, marks.size)
  }

  for (const existing of Array.from(doc.querySelectorAll(`[${BADGE_ATTR}]`))) {
    const host = existing.parentElement
    if (!host || !wanted.has(host)) existing.remove()
  }

  for (const [header, count] of wanted) {
    let badge = header.querySelector(`[${BADGE_ATTR}]`)
    if (!badge) {
      badge = doc.createElement('span')
      badge.setAttribute(BADGE_ATTR, '1')
      // Inline style: this document is the course's own HTML and carries no
      // stylesheet of ours, and injecting one would be a second thing to own.
      badge.setAttribute(
        'style',
        'display:inline-flex;align-items:center;gap:0.3em;margin-left:0.6em;' +
        'padding:0.05em 0.5em;border-radius:999px;font-size:0.75em;font-weight:600;' +
        'background:#b3261e;color:#fff;vertical-align:middle;',
      )
      header.appendChild(badge)
    }
    const label = count === 1 ? '1 comment' : `${count} comments`
    if (badge.textContent !== label) badge.textContent = label
  }
}

/**
 * Disconnect observers for documents that are no longer mounted.
 *
 * Attaching only ever added. A pane that swaps its iframe — which happens every
 * time the instructor flicks to the next student — left a live MutationObserver
 * on the retired document until the hook itself tore down. Those observers keep
 * firing and each one schedules a placement pass, so the cost grows per student
 * instead of staying flat, and the retired document cannot be collected.
 *
 * Exported so this is testable without a browser: it is the one part of the
 * mount lifecycle that needs no layout to observe.
 */
export function pruneRetiredObservers(
  observers: Map<Document, { disconnect(): void }>,
  live: Set<Document>,
): Document[] {
  const retired: Document[] = []
  for (const [doc, observer] of observers) {
    if (live.has(doc)) continue
    observer.disconnect()
    observers.delete(doc)
    retired.push(doc)
  }
  return retired
}

/**
 * A one-frame coalescer bound to a window that outlives the documents it serves.
 *
 * The owner matters and is the whole reason this is a named thing. The id used
 * to be taken from whichever iframe Window triggered the placement, and that
 * window is destroyed when its mount is replaced — which happens every time the
 * instructor flicks to the next student. The pending callback then never runs,
 * the pending flag stays set, and the `if (pending) return` guard silences every
 * later placement for the life of the hook. A stale mark, permanently, with no
 * error anywhere.
 *
 * Injected rather than reaching for `window` so the failure is testable: a
 * scheduler given a window that never fires is exactly a replaced iframe.
 */
export function createFrameScheduler(view: {
  requestAnimationFrame(cb: () => void): number
  cancelAnimationFrame(id: number): void
}) {
  let pending = 0
  return {
    schedule(run: () => void) {
      if (pending) return
      pending = view.requestAnimationFrame(() => { pending = 0; run() })
    },
    cancel() {
      if (pending) view.cancelAnimationFrame(pending)
      pending = 0
    },
    isPending: () => pending !== 0,
  }
}

/**
 * Which collapsed panels are hiding this mark, IN EACH DOCUMENT SEPARATELY.
 *
 * A badge describes the document it is drawn in, so it has to be computed there.
 * Two earlier versions got this wrong in ways that both read as working:
 *
 *   - keyed off the GOVERNING document, inside the hide branch. An open
 *     governing view suppressed badges in copies that were closed; a closed one
 *     stamped badges onto copies that were open.
 *   - run AFTER the governing guard. With the governing mount momentarily absent
 *     — exactly while a pane swaps iframes — no document's badges were computed,
 *     `hidden` came back empty, and the reconcile pass REMOVED badges from
 *     solutions that were still closed and still held feedback.
 *
 * Exported so the branch wiring can be exercised with controlled rects.
 */
export function collectHiddenPanels(
  mounts: AnchorContext[],
  anchor: SpanAnchor,
  shapeId: string,
  note: (doc: Document, panel: Element, shapeId: string) => void,
) {
  for (const mounted of mounts) {
    // Resolves in this document => this document is not hiding it.
    if (spanPageY(mounted, anchor)) continue
    // Either end will do — a mark is hidden because its content is closed — and
    // the caller keys on the shape, so both ends of one diagonal are one mark.
    for (const end of [anchor.top, anchor.bottom]) {
      const el = resolveAnchorKey(end.key, mounted.doc)
      const panel = el?.closest('.collapse')
      if (!panel) continue
      note(mounted.doc, panel, shapeId)
    }
  }
}

/**
 * Wait for mounts that are not ready yet, on their own `load`.
 *
 * A mount whose body has not arrived cannot be observed — `observe(null)` throws
 * and takes the whole surface to its error boundary. Skipping it is right for
 * this pass and wrong forever: that iframe is where a reader will be looking a
 * moment later, and its marks would never be placed and its solutions never
 * badged.
 *
 * `load` is the document's own readiness notification, so this waits rather than
 * polls. One listener per frame, `once`, tracked so repeated passes do not stack
 * duplicates, and returned so teardown can remove any that never fired.
 */
export function awaitPendingMounts(
  frames: HTMLIFrameElement[],
  awaiting: Map<HTMLIFrameElement, () => void>,
  onReady: () => void,
): number {
  let added = 0
  for (const frame of frames) {
    if (awaiting.has(frame)) continue
    const handler = () => { awaiting.delete(frame); onReady() }
    frame.addEventListener('load', handler, { once: true })
    awaiting.set(frame, handler)
    added++
  }
  return added
}

type AnchoredMeta = {
  contentAnchor?: SpanAnchor
  /**
   * The page shape the anchor is relative to, so any view can resolve it.
   *
   * This is written in the instructor's editor and read in the student's, which
   * only works because the id is content-derived rather than per-room:
   * `src/loaders/htmlLoader.ts:177` builds it as `${document.name}-page-${i}`,
   * and both views name the document by the submission's `contentRef` — the
   * grading surface through `ProblemMarking`, the student's through
   * `createHtmlDocumentFromPageInfo(submission.contentRef, …)`. Measured as well
   * as derived: a mark carrying `shape:submission-<assignment>-<student>-page-0`
   * resolved in the student's view and rendered against its content.
   *
   * If that derivation ever becomes per-room, the student side stops resolving
   * SILENTLY — marks sit at their last shared position, plausible and wrong.
   */
  contentAnchorPage?: string
  /**
   * The mark's height when it was drawn.
   *
   * `scaleY` is absolute against the shape's original geometry, not cumulative,
   * so the stretch has to be computed from the height at draw time. Deriving it
   * from the current height instead would compound on every expand and the mark
   * would creep.
   */
  contentAnchorHeight?: number
}

const isMarkShape = (shape: { type: string }) =>
  shape.type === 'draw' || shape.type === 'highlight'

const isMarkRecord = (record: any) =>
  record?.typeName === 'shape' && isMarkShape(record)

/**
 * Whether an update is only this hook's own derived placement.
 *
 * The placement pass writes exactly three things — `y`, `opacity` and
 * `props.scaleY` — so an update touching nothing else is this hook hearing
 * itself and must not schedule another pass.
 *
 * It is deliberately NOT done by filtering on `source: 'user'`. That looked like
 * the same thing and is not: a mark arriving from the server — a Return landing
 * while the student has the document open — is applied through
 * `mergeRemoteChanges` by `TLSyncClient`, so it reads as `'remote'`, exactly like
 * this hook's own writes. Filtering by source silenced the one event the student
 * side exists to react to.
 *
 * Errs toward scheduling: `meta` compares by reference, so a replaced-but-equal
 * meta counts as a real change. An extra placement is idempotent; a missed one
 * leaves a mark in the wrong place.
 */
export function isDerivedPlacementOnly(from: any, to: any): boolean {
  if (!isMarkRecord(from) || !isMarkRecord(to)) return false
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (key === 'y' || key === 'opacity') continue
    if (key === 'props') {
      const before = from.props ?? {}
      const after = to.props ?? {}
      for (const prop of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (prop === 'scaleY') continue
        if (before[prop] !== after[prop]) return false
      }
      continue
    }
    if (from[key] !== to[key]) return false
  }
  return true
}

/**
 * A mark sits on the student's work, not on the page.
 *
 * Skip specified this directly: *"It wouldn't be that it has a fixed position on
 * the page necessarily. It has a fixed position relative to the particular pair"*
 * and *"the actual position of the stuff would basically be computed"*.
 *
 * So the shape carries an anchor — the content under each of its two ends — and
 * every view that renders it computes where that content currently is. Two ends
 * rather than one: translating a diagonal by its top anchor alone leaves it
 * crossing the top third of a solution that grew, which keeps its position and
 * loses its meaning.
 *
 * **The computed position is never written back to shared truth.** Two people
 * with different solutions expanded would otherwise fight over one shape's `y`,
 * and a returned mark would reach the student carrying the instructor's collapse
 * state. Placement goes through `store.mergeRemoteChanges`, the same primitive
 * `src/loaders/createShapes.ts:59` uses to keep a local write out of the room —
 * which also works under read-only, as the student's view is.
 *
 * The trigger is a mutation, not a size. Expanding a solution **moves content
 * without changing the document's height**: measured on the real chapter, the
 * content below moved 79px while `body.scrollHeight` changed by 0 and a
 * `ResizeObserver` fired 0 times on both `body` and `documentElement`. A
 * `MutationObserver` fired twice. Any size-based signal — including the page's
 * existing `tlda-resize` — is blind to this.
 */
export function useContentAnchoredMarks(
  editor: Editor | null,
  markEditor: Editor | null,
  options: {
    anchorOnCreate?: boolean
    pageShapeId?: TLShapeId
    // The view this hook serves. A page shape mounts once per pane, the mounts
    // disagree about collapse state, and a mark has one opacity — so the caller,
    // which is the only thing that knows which view is its own, names it.
    governingRoot?: () => Element | null
  } = {},
) {
  const { anchorOnCreate = false, pageShapeId, governingRoot } = options

  // Record the content under a mark once it is FINISHED, not when it appears.
  //
  // tldraw's draw tool creates the shape at pointer-down and grows it through
  // updates — `Drawing.startShape()` calls `editor.createShape` and only later
  // sets `isComplete: true`. Anchoring on `changes.added` therefore measured the
  // initial dot: the span's two ends landed on the same point and
  // `contentAnchorHeight` came out ~0, which fails the `drawn > 1` guard below,
  // so a real drawn mark would never stretch — the single-anchor defect this
  // exists to prevent, reintroduced by the wiring.
  //
  // Seeded shapes arrive already complete in `added`, which is why no
  // seeded-shape test could see this.
  useEffect(() => {
    if (!anchorOnCreate || !editor || !markEditor || !pageShapeId) return
    return markEditor.store.listen(({ changes }) => {
      const candidates: any[] = [
        ...Object.values(changes.added),
        ...Object.values(changes.updated).map((pair: any) => pair[1]),
      ]
      for (const record of candidates) {
        if (record.typeName !== 'shape' || !isMarkShape(record)) continue
        if ((record.meta as AnchoredMeta)?.contentAnchor) continue
        // The stroke is still being drawn; its geometry is not final yet.
        if (!record.props?.isComplete) continue
        const page = editor.getShape(pageShapeId) as any
        if (!page) continue
        // The GOVERNING mount, not the registry's arbitrary one. A stroke is
        // drawn over the view the instructor is looking at, so the anchor has to
        // be read from that view's document: recording it against a different
        // mount writes an anchor for content the mark was never over, and it is
        // stored, so nothing later corrects it.
        const { governing: context } =
          anchorContexts(page, governingRoot ? governingRoot() : undefined)
        if (!context) continue
        const bounds = markEditor.getShapePageBounds(record.id)
        if (!bounds) continue
        const anchor = spanAnchorFor(context, bounds.minY, bounds.maxY)
        // Nothing anchorable under it: the mark keeps its page position, which is
        // the behaviour that exists today rather than a silent failure.
        if (!anchor) continue
        markEditor.updateShape({
          id: record.id,
          type: record.type,
          meta: {
            ...record.meta,
            contentAnchor: anchor,
            contentAnchorPage: String(pageShapeId),
            contentAnchorHeight: bounds.h,
          },
        })
      }
    }, { source: 'user', scope: 'document' })
  }, [anchorOnCreate, editor, markEditor, pageShapeId])

  // Place every anchored mark wherever its content is now, locally.
  useEffect(() => {
    if (!editor || !markEditor) return

    // Declared before `placeAll` because badge reconciliation reads it: the
    // documents being watched, NOT the documents some mark happens to point at.
    const observers = new Map<Document, MutationObserver>()
    // Frames that exist but are not ready, each waiting on its own `load`.
    const awaiting = new Map<HTMLIFrameElement, () => void>()
    // Bound to the OUTER window, which outlives every mount.
    const scheduler = createFrameScheduler(window)

    const placeAll = () => {
      // Every mount of the page, not the registry's single arbitrary one. The
      // GOVERNING context is the one the caller named, and it decides whether a
      // mark is showing; badges are written to all of them, because the reader
      // may be looking at any.
      const allContexts = new Map<string, AnchorContext[]>()
      const contexts = new Map<string, ReturnType<typeof anchorContext>>
      const updates: any[] = []
      // Every anchored mark that resolved, whether or not its scale changed.
      // The translation pass below reads THIS, not `updates`: a mark whose
      // content merely moved down has the same scale and would otherwise be
      // skipped — the pure-translation case, which is most of them.
      const resolved: Array<{ id: any; ends: { top: number; bottom: number } }> = []
      // Collapsed solutions that are hiding at least one mark, and WHICH marks —
      // a Set per panel, so a mark whose two ends both land in the same solution
      // counts once. Skip asked to "badge them"; he did not ask to count anchors.
      //
      // Keyed by DOCUMENT first: a panel Element belongs to the mount it was
      // resolved in, so one flat map would hand a badge pass nodes from a
      // different document and find nothing. Each mount gets its own panels.
      const hidden = new Map<Document, Map<Element, Set<string>>>()
      const noteHidden = (doc: Document, panel: Element, shapeId: string) => {
        const panels = hidden.get(doc) ?? new Map<Element, Set<string>>()
        const marks = panels.get(panel) ?? new Set<string>()
        marks.add(shapeId)
        panels.set(panel, marks)
        hidden.set(doc, panels)
      }

      for (const shape of markEditor.getCurrentPageShapes() as any[]) {
        const meta = shape.meta as AnchoredMeta
        if (!meta?.contentAnchor || !meta.contentAnchorPage) continue

        if (!contexts.has(meta.contentAnchorPage)) {
          const page = editor.getShape(meta.contentAnchorPage as TLShapeId) as any
          const mounted = page
            ? anchorContexts(page, governingRoot ? governingRoot() : undefined)
            : { all: [], governing: null }
          allContexts.set(meta.contentAnchorPage, mounted.all)
          contexts.set(meta.contentAnchorPage, mounted.governing)
        }
        // Each document's badges come from ITS OWN resolution, decided before the
        // governing guard below and independently of whichever view governs.
        collectHiddenPanels(
          allContexts.get(meta.contentAnchorPage) ?? [],
          meta.contentAnchor,
          String(shape.id),
          noteHidden,
        )

        const context = contexts.get(meta.contentAnchorPage)
        if (!context) continue

        const ends = spanPageY(context, meta.contentAnchor)

        // The solution this mark is inside is collapsed in the governing view, so
        // its content has no box. Skip settled what happens: "the marking stuff is
        // only visible when things are expanded", with a badge on the collapsed
        // solution. Hiding is also the only honest option — any fallback position
        // paints the mark somewhere it was never drawn.
        if (!ends) {
          if (shape.opacity !== 0) updates.push({ ...shape, opacity: 0 })
          continue
        }

        const next = { ...shape, props: { ...shape.props } }
        if (shape.opacity === 0) next.opacity = 1

        // Both ends, not one. Translating by the top anchor alone would leave a
        // diagonal crossing the top third of a solution that grew — position
        // kept, meaning lost, which is the defect this exists for.
        //
        // `scaleY` reaches both the rendered points and the bounds: tldraw's
        // `DrawShapeUtil` passes it to `getPointsFromDrawSegments` in
        // `getGeometry`, in `getIndicatorPath` and in the component itself.
        //
        // It is absolute against the shape's original geometry, not cumulative —
        // `onResize` is what multiplies (`info.scaleY * shape.props.scaleY`). So
        // this is computed from the height at draw time; from the current height
        // it would compound on every expand and the mark would creep.
        const drawn = meta.contentAnchorHeight || 0
        if (drawn > 1) {
          const scaleY = (ends.bottom - ends.top) / drawn
          if (Number.isFinite(scaleY) && scaleY > 0) next.props.scaleY = scaleY
        }

        // Only when something actually differs. This ran unconditionally, which
        // was a write per mark per mutation frame even when every mark was
        // already in the right place — harmless-looking while the observer only
        // watched collapse toggles, and continuous churn now that it watches the
        // whole document settle.
        const moved =
          next.opacity !== shape.opacity ||
          Math.abs((next.props.scaleY ?? 1) - (shape.props.scaleY ?? 1)) > 0.0005
        if (moved) updates.push(next)
        resolved.push({ id: shape.id, ends })
      }

      // Local only. These coordinates depend on which solutions THIS viewer has
      // expanded, and that must never become shared truth: two people with
      // different panels open would fight over one shape, and a returned mark
      // would carry the instructor's collapse state to the student.
      if (updates.length) {
        markEditor.store.mergeRemoteChanges(() => { markEditor.store.put(updates) })
      }

      // Translate after scaling, because the scale changes where the top edge
      // lands and the anchor is about the edge rather than the origin. Read the
      // bounds back from the editor rather than from `next`, so this measures
      // the geometry the scale above actually produced.
      const placements: any[] = []
      for (const { id, ends } of resolved) {
        const bounds = markEditor.getShapePageBounds(id)
        if (!bounds) continue
        const dy = ends.top - bounds.minY
        if (Math.abs(dy) <= 0.5) continue
        const shape = markEditor.getShape(id) as any
        if (shape) placements.push({ ...shape, y: shape.y + dy })
      }
      if (placements.length) {
        markEditor.store.mergeRemoteChanges(() => { markEditor.store.put(placements) })
      }

      // Badge the closed solutions — over every WATCHED document, not over the
      // documents some mark pointed at.
      //
      // Keyed off `contexts` this skipped entirely when the last mark went away:
      // no marks, no contexts, no reconciliation, and the badge stayed on the
      // page claiming feedback that no longer exists. `hidden` being empty is a
      // real state that has to be rendered, not a reason to render nothing.
      // Empty map, not "skip": a document with nothing hidden must have its badge
      // REMOVED, and passing nothing would leave a stale one claiming feedback.
      const EMPTY = new Map<Element, Set<string>>()
      for (const doc of observers.keys()) renderFeedbackBadges(doc, hidden.get(doc) ?? EMPTY)
      for (const mounted of allContexts.values()) {
        for (const context of mounted) {
          if (observers.has(context.doc)) continue
          renderFeedbackBadges(context.doc, hidden.get(context.doc) ?? EMPTY)
        }
      }
    }

    // The document may not be mounted when this first runs, and the iframe is
    // replaced when the student changes. `tlda-resize` cannot report a reflow,
    // but it does reliably report that a page now exists — which is when there
    // is something to observe.

    // Coalesce: one placement per frame however many records arrive. A document
    // settling can emit hundreds, and `placeAll` already writes nothing when a
    // mark is where it should be, so the frame boundary is the only throttle
    // needed.
    //
    // Scheduled on the OUTER window, never on an iframe's. The id was taken from
    // whichever document's view triggered it, and that window is destroyed when
    // its mount is replaced — every flick to the next student. The callback then
    // never fires, `scheduled` stays nonzero, and the `if (scheduled) return`
    // guard blocks EVERY future placement for the life of the hook. Teardown made
    // it worse by cancelling the id against a different window's
    // `cancelAnimationFrame`, which does nothing at all.
    //
    // The outer window outlives every mount, so its id is always cancellable and
    // its callback always runs.
    const schedule = () => scheduler.schedule(placeAll)

    const attach = () => {
      // Every document currently mounted for any page, so retired ones can be
      // told apart from new ones.
      const live = new Set<Document>()
      for (const page of editor.getCurrentPageShapes() as any[]) {
        if (page.type !== 'html-page') continue
        // Observe EVERY mount. Watching only the registry's copy meant a reader
        // could expand a solution in their own pane and nothing re-placed, because
        // the mutation happened in a document nobody was listening to.
        const mounted = anchorContexts(page, governingRoot ? governingRoot() : undefined)
        // Not ready is not the same as gone: pick it up when its document loads.
        awaitPendingMounts(mounted.pending, awaiting, attach)
        for (const context of mounted.all) {
        live.add(context.doc)
        if (observers.has(context.doc)) continue
        const view = context.doc.defaultView
        if (!view) continue
        // Watch any structural or style change, not just `.collapse` classes.
        //
        // Filtering to collapsibles was measurably too narrow: content inserted
        // between a mark's two anchors moved it 260px and nothing re-placed,
        // because an insertion is not a class change. The same hole covers
        // MathJax finishing its typeset, images and fonts loading, and anything
        // else that settles after first paint — and this page runs MathJax.
        const observer = new view.MutationObserver(records => {
          if (!isOwnBadgeWrite(records)) schedule()
        })
        observer.observe(context.doc.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['class', 'style'],
        })
        observers.set(context.doc, observer)
        }
      }

      pruneRetiredObservers(observers, live)

      placeAll()
    }

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'tlda-resize') attach()
    }

    // Marks changing is a reason to place again, and nothing here was listening
    // for it: the only store listener was the creation effect, so this ran on
    // document mutations and page loads alone. A mark deleted, or carried away by
    // a Return, left its badge counting feedback that was no longer there.
    //
    // ALL sources, filtered by WHAT changed rather than by who changed it. A
    // returned mark reaching a student whose document is already open arrives
    // through `TLSyncClient`, which applies it via `mergeRemoteChanges` — so it
    // is `'remote'`, indistinguishable by source from this hook's own placement
    // writes. Filtering on `source: 'user'` therefore silenced precisely the
    // event the student side exists to handle.
    const unsubscribe = markEditor.store.listen(({ changes }) => {
      const real =
        Object.values(changes.added).some(isMarkRecord) ||
        Object.values(changes.removed).some(isMarkRecord) ||
        Object.values(changes.updated).some(([from, to]: any) =>
          isMarkRecord(to) && !isDerivedPlacementOnly(from, to))
      if (!real) return
      schedule()
    }, { scope: 'document' })

    attach()
    window.addEventListener('message', onMessage)
    return () => {
      unsubscribe()
      window.removeEventListener('message', onMessage)
      scheduler.cancel()
      for (const [frame, handler] of awaiting) frame.removeEventListener('load', handler)
      awaiting.clear()
      for (const [doc, observer] of observers) {
        observer.disconnect()
        // Take our badges back out. The document can outlive this hook — the
        // iframe survives while the component unmounts — and a badge left behind
        // says "there is feedback in here" with nothing left to reveal it.
        // Disconnect first, so removing them cannot schedule a placement.
        for (const badge of Array.from(doc.querySelectorAll(`[${BADGE_ATTR}]`))) badge.remove()
      }
      observers.clear()
    }
  }, [editor, markEditor])
}
