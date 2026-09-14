/**
 * The caller's half of the completion contract, driven through the REAL
 * registry rather than a hand-made watch.
 *
 * Two things only this level can catch, and a fabricated watch missed both:
 *
 * - a document arriving after the bound must still produce a remap — the old
 *   `.finally(dispose)` on a 1500ms race dropped a load at 1501ms entirely;
 * - a shape being REMOVED must not look like a document arriving. Disposal
 *   settles the wait, so a caller that only asks "did it settle" remaps on a
 *   deletion. That is what made the first version of this wrong.
 */
import { watchHtmlPageReload, remapOnLateHtmlLoad, cancelHtmlReloadWatches } from './htmlReloadWatch'
import {
  htmlIframeElements,
  noteHtmlIframeLoaded,
  disposeHtmlIframeLoadWaiters,
  htmlIframeLoadWaiterCount,
} from './htmlIframeRegistry'

function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
}
const tick = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)) }

const SHAPE = 'shape:page-0'
const URL_V1 = 'https://host/docs/p/ch.html?_tldaReload=1'
const frame = (href: string) => ({ src: href, contentWindow: { location: { href } } } as unknown as HTMLIFrameElement)

function reset() {
  disposeHtmlIframeLoadWaiters(SHAPE)
  htmlIframeElements.delete(SHAPE)
}

// 1. LATE LOAD — the bound has ACTUALLY passed, then the document arrives.
//    `await watch.bounded` is the point: with nothing loaded it settles by the
//    real HTML_RELOAD_TIMEOUT_MS, so what follows is genuinely after the bound.
//    Ticking a few macrotasks instead would have tested "fires on load" and
//    called it "fires late" — the hole was that the old timeout DISPOSED here.
reset()
{
  const watch = watchHtmlPageReload(SHAPE, URL_V1)
  let remaps = 0
  remapOnLateHtmlLoad([watch], () => { remaps += 1 })
  await watch.bounded
  equal(watch.isLoaded(), false, 'late load: the bound expired without a document')
  equal(remaps, 0, 'late load: no remap before the document arrives')
  equal(htmlIframeLoadWaiterCount(SHAPE), 1, 'late load: the wait is retained past the bound')

  noteHtmlIframeLoaded(SHAPE, frame(URL_V1))
  await tick()
  equal(remaps, 1, 'late load: a document arriving after the bound DOES remap')
  equal(htmlIframeLoadWaiterCount(SHAPE), 0, 'late load: released after firing')
}

// 2. SHAPE REMOVED — real registry disposal. The wait settles, and the caller
//    must NOT treat that as a load. CONTROL for case 1: without the
//    load/cancel distinction this reports a remap for a deleted shape.
reset()
{
  const watch = watchHtmlPageReload(SHAPE, URL_V1)
  let remaps = 0
  remapOnLateHtmlLoad([watch], () => { remaps += 1 })
  await tick()
  equal(remaps, 0, 'shape removed: nothing yet')

  disposeHtmlIframeLoadWaiters(SHAPE)
  await tick()
  equal(remaps, 0, 'shape removed: removal is NOT a load and must not remap')
  equal(htmlIframeLoadWaiterCount(SHAPE), 0, 'shape removed: continuation released')
}

// 3. LOADED WITHIN THE BOUND — the batch remap already covered it, so no second
//    remap. CONTROL: proves the continuation is conditional rather than
//    attached to every reload.
reset()
{
  const watch = watchHtmlPageReload(SHAPE, URL_V1)
  noteHtmlIframeLoaded(SHAPE, frame(URL_V1))
  await tick()
  equal(watch.isLoaded(), true, 'in-bound: watch reports loaded')

  let remaps = 0
  remapOnLateHtmlLoad([watch], () => { remaps += 1 })
  await tick()
  equal(remaps, 0, 'in-bound: no second remap')
  equal(htmlIframeLoadWaiterCount(SHAPE), 0, 'in-bound: nothing retained')
}

// 4. A STALE DOCUMENT ARRIVING — a different url must not satisfy this reload,
//    so no remap. CONTROL against matching on "some load happened".
reset()
{
  const watch = watchHtmlPageReload(SHAPE, URL_V1)
  let remaps = 0
  remapOnLateHtmlLoad([watch], () => { remaps += 1 })
  await tick()

  noteHtmlIframeLoaded(SHAPE, frame('https://host/docs/p/ch.html?_tldaReload=0'))
  await tick()
  equal(remaps, 0, 'stale document: an earlier navigation does not remap this reload')
  equal(htmlIframeLoadWaiterCount(SHAPE), 1, 'stale document: this reload is still waiting')

  noteHtmlIframeLoaded(SHAPE, frame(URL_V1))
  await tick()
  equal(remaps, 1, 'stale document: the requested one still remaps when it lands')
}

// 5. EDITOR TORN DOWN between the reload and the late document. The document
//    really does arrive — so this is not the cancellation case — but there is
//    no longer an editor worth remapping.
reset()
{
  const watch = watchHtmlPageReload(SHAPE, URL_V1)
  let remaps = 0
  let alive = true
  remapOnLateHtmlLoad([watch], () => { remaps += 1 }, () => alive)
  await watch.bounded                             // the bound really expires
  equal(watch.isLoaded(), false, 'editor torn down: bound expired without a document')

  alive = false                                   // editor disposed
  noteHtmlIframeLoaded(SHAPE, frame(URL_V1))      // the document genuinely loads
  await tick()
  equal(remaps, 0, 'editor torn down: a late document does NOT remap a disposed editor')
  equal(htmlIframeLoadWaiterCount(SHAPE), 0, 'editor torn down: continuation still released')
}

// 6. CONTROL for case 5 — identical sequence with the editor alive. Without
//    this, case 5 passes for a fix that never remaps at all.
reset()
{
  const watch = watchHtmlPageReload(SHAPE, URL_V1)
  let remaps = 0
  const alive = true
  remapOnLateHtmlLoad([watch], () => { remaps += 1 }, () => alive)
  await watch.bounded                             // same sequence, same timing

  noteHtmlIframeLoaded(SHAPE, frame(URL_V1))
  await tick()
  equal(remaps, 1, 'editor alive control: the same late document DOES remap')
}

// 7. TEARDOWN WITH NO LOAD EVER — the case shape-deletion cleanup does not
//    cover. An editor can be torn down without its shapes being removed one by
//    one, and a frame that never loads would otherwise leave its wait
//    outstanding for ever. Waiter count must return to zero.
reset()
{
  const watch = watchHtmlPageReload(SHAPE, URL_V1)
  let remaps = 0
  remapOnLateHtmlLoad([watch], () => { remaps += 1 })
  await watch.bounded
  equal(htmlIframeLoadWaiterCount(SHAPE), 1, 'no-load teardown: outstanding before teardown')

  cancelHtmlReloadWatches([watch])                // what editor.disposables runs
  await tick()
  equal(htmlIframeLoadWaiterCount(SHAPE), 0, 'no-load teardown: waiter count returns to ZERO')
  equal(remaps, 0, 'no-load teardown: cancelling is not a load, so no remap')
}

// 8. CANCELLING ONE EDITOR'S WATCH LEAVES ANOTHER'S ALONE on the same shape.
//    This is why cancellation takes watch objects and not a shape id.
reset()
{
  const mine = watchHtmlPageReload(SHAPE, URL_V1)
  const theirs = watchHtmlPageReload(SHAPE, URL_V1)
  equal(htmlIframeLoadWaiterCount(SHAPE), 2, 'two editors: both waiting on the same shape')

  cancelHtmlReloadWatches([mine])
  await tick()
  equal(htmlIframeLoadWaiterCount(SHAPE), 1, 'two editors: only the cancelled one is released')

  let theirRemaps = 0
  remapOnLateHtmlLoad([theirs], () => { theirRemaps += 1 })
  noteHtmlIframeLoaded(SHAPE, frame(URL_V1))
  await tick()
  equal(theirRemaps, 1, 'two editors: the surviving editor still gets its remap')
}

reset()
console.log('htmlReloadLateRemap: 8 cases pass')
