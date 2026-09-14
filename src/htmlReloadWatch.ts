/**
 * The caller's half of the html-page reload completion contract.
 *
 * `htmlIframeRegistry` answers "has this shape's frame loaded THIS document".
 * This decides what a reload does with that answer: wait a bounded time before
 * remapping, and still remap if the document arrives afterwards.
 *
 * Separate from `editorSetup` so the behaviour can be tested without loading the
 * editor — the case that matters is bound-expired-then-load, which cannot be
 * reached from the registry alone.
 */
import { whenHtmlIframeLoaded } from './htmlIframeRegistry'

/**
 * How long a reload blocks the remap.
 *
 * A bound on waiting, not the completion signal. Completion is the frame
 * reporting the requested document; expiring here costs nothing, because the
 * resolver answers `null` for a frame it cannot read and the anchor is held
 * rather than overwritten.
 */
export const HTML_RELOAD_TIMEOUT_MS = 1500

function settleAfter(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export type HtmlReloadWatch = {
  /** Settles when the document loads OR the bound expires — what the batch waits on. */
  bounded: Promise<void>
  /** Settles `true` on the real load however late, `false` if the wait was cancelled. */
  loaded: Promise<boolean>
  /** True once the document has actually loaded. */
  isLoaded: () => boolean
  dispose: () => void
}

export function watchHtmlPageReload(shapeId: string, requestedUrl: string): HtmlReloadWatch {
  const { loaded, dispose } = whenHtmlIframeLoaded(shapeId, requestedUrl)
  let done = false
  const tracked = loaded.then(ok => { done = ok; return ok })
  return {
    bounded: Promise.race([tracked.then(() => {}), settleAfter(HTML_RELOAD_TIMEOUT_MS)]),
    loaded: tracked,
    isLoaded: () => done,
    dispose,
  }
}

/**
 * Give every reload that had not finished by the bound one more remap when its
 * document actually arrives.
 *
 * Without this the bound IS the contract: a load at 1501ms produced no remap at
 * all, because the waiter was disposed at 1500. One continuation per outstanding
 * reload — not a poll and not a retry schedule.
 *
 * A frame that never loads keeps its waiter, which
 * `disposeHtmlIframeLoadWaiters` releases when the shape goes — as a
 * CANCELLATION, so no remap follows a deletion.
 *
 * `isStillWanted` is checked when the document ARRIVES, not when the
 * continuation is set up: a late load is exactly the case where the editor may
 * have been torn down in between, and remapping then is work against a store
 * nobody is reading.
 */
/**
 * Cancel a specific set of outstanding reload waits.
 *
 * Takes the watch objects rather than a shape id on purpose: two editors can
 * hold waits on the same shape, and tearing one down must not release the
 * other's. Safe on a watch that has already settled.
 */
export function cancelHtmlReloadWatches(watches: HtmlReloadWatch[]) {
  for (const watch of watches) watch.dispose()
}

export function remapOnLateHtmlLoad(
  watches: HtmlReloadWatch[],
  runRemap: () => void,
  isStillWanted: () => boolean = () => true,
): Promise<void>[] {
  const late: Promise<void>[] = []
  for (const watch of watches) {
    if (watch.isLoaded()) { watch.dispose(); continue }
    late.push(watch.loaded.then(loaded => {
      // `false` means the wait was cancelled — the shape went away. A
      // cancellation is NOT a document arriving, and remapping on it would fire
      // on shape deletion.
      if (!loaded) return
      if (!isStillWanted()) return
      runRemap()
    }).finally(watch.dispose))
  }
  return late
}
