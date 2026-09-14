/**
 * Resolving a stored anchor must distinguish "the source moved on" from "I
 * cannot answer right now".
 *
 * `remapAnnotations` PERSISTS an unanchored result into the note's meta and then
 * filters those notes out of every later remap. So an unanchored value returned
 * for a transient condition does not report a failure — it destroys the anchor,
 * permanently, on one reload. `null` is the non-destructive answer: the caller
 * skips without writing.
 *
 * Measured before the repair: a remap that ran while the iframe was mid-refresh
 * turned `{anchored: true, line: 29}` into `{anchored: false, reason:
 * 'missing-iframe'}` and the note never re-anchored.
 */
import { htmlIframeElements } from './htmlIframeRegistry'
import { htmlSourceLineCanvasPosition } from './htmlSourceAnchors'

function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
}

const SHAPE = { id: 'shape:page-0', props: { h: 1000, source: 'chapter.qmd' } }
const BOUNDS = { x: 0, y: 0, w: 800, h: 1000 }

function element(opts: { rendered: boolean; offsetTop?: number }) {
  return {
    offsetTop: opts.offsetTop ?? 400,
    getClientRects: () => (opts.rendered ? [{ width: 600, height: 20 }] : []),
  }
}

function registerIframe(doc: unknown | null) {
  htmlIframeElements.set(SHAPE.id, {
    contentDocument: doc,
    clientHeight: 1000,
    contentWindow: { scrollY: 0 },
  } as unknown as HTMLIFrameElement)
}

function docWith(el: unknown | null) {
  return {
    getElementById: () => null,
    querySelector: () => el,
    documentElement: { scrollTop: 0 },
    body: { scrollTop: 0 },
  }
}

// 1. No iframe registered — the shape is mid-remount. Transient.
//    BEFORE the repair this returned {anchored:false, reason:'missing-iframe'},
//    which the caller wrote into the note and never revisited.
htmlIframeElements.delete(SHAPE.id)
equal(
  htmlSourceLineCanvasPosition(SHAPE, BOUNDS, 29),
  null,
  'no iframe yields null so the stored anchor is preserved',
)

// 2. Iframe present but its document is not — mid-navigation. Transient.
registerIframe(null)
equal(
  htmlSourceLineCanvasPosition(SHAPE, BOUNDS, 29),
  null,
  'iframe without a document yields null',
)

// 3. Document present, line genuinely absent — the source moved on. This is a
//    real answer about the source and must NOT be softened to null, or a note
//    whose line is gone would hold a stale position for ever.
registerIframe(docWith(null))
const gone = htmlSourceLineCanvasPosition(SHAPE, BOUNDS, 29)
equal(gone && (gone as { anchored: boolean }).anchored, false, 'absent line reports unanchored')
equal(
  gone && (gone as { reason?: string }).reason,
  'missing-line-anchor',
  'absent line keeps missing-line-anchor semantics',
)

// 4. Block present but with no layout box — collapsed callout, or the document
//    has not laid out yet. The anchor outlives both, so hold rather than answer.
registerIframe(docWith(element({ rendered: false })))
equal(
  htmlSourceLineCanvasPosition(SHAPE, BOUNDS, 29),
  null,
  'unlaid-out block yields null rather than discarding the anchor',
)

// 5. The ordinary case still resolves, or the repair would have bought
//    preservation by never anchoring anything.
registerIframe(docWith(element({ rendered: true, offsetTop: 400 })))
const ok = htmlSourceLineCanvasPosition(SHAPE, BOUNDS, 29)
equal(ok && (ok as { anchored: boolean }).anchored, true, 'a laid-out block resolves')
equal(ok && (ok as { canvasY: number }).canvasY, 400, 'canvasY follows offsetTop at scale 1')

htmlIframeElements.delete(SHAPE.id)
console.log('htmlSourceAnchorResolve: 5 cases pass')
