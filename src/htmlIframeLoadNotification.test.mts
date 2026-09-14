/**
 * The reload path's completion contract.
 *
 * A reload must learn that ITS OWN navigation finished. Waiting on an element's
 * `load` cannot do that: attach before the url changes and a replacement's load
 * is missed; attach after and a load that already fired is missed; and either
 * way an earlier navigation's load looks identical to the one being waited for.
 *
 * Completion is therefore keyed to the requested URL. A counter would prove
 * another load happened, not that the requested document is in the frame.
 *
 * Each case below has a control — the assertion that would catch the fix being
 * vacuous, e.g. resolving everything immediately or never resolving at all.
 */
import {
  htmlIframeElements,
  noteHtmlIframeLoaded,
  whenHtmlIframeLoaded,
  disposeHtmlIframeLoadWaiters,
  htmlIframeLoadWaiterCount,
} from './htmlIframeRegistry'

function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
}

const SHAPE = 'shape:page-0'
const frame = (href: string) => ({ src: href, contentWindow: { location: { href } } } as unknown as HTMLIFrameElement)
/**
 * What the wait did by the next macrotask.
 *
 * Three outcomes, not two: a cancelled wait SETTLES, so "did it settle" cannot
 * tell a document arriving from a shape being deleted — which is the confusion
 * that made a removal look like a completed reload.
 */
const outcome = async (p: Promise<boolean>): Promise<'pending' | 'loaded' | 'cancelled'> => {
  let result: 'pending' | 'loaded' | 'cancelled' = 'pending'
  void p.then(loaded => { result = loaded ? 'loaded' : 'cancelled' })
  await new Promise(r => setTimeout(r, 0))
  return result
}

function reset() {
  disposeHtmlIframeLoadWaiters(SHAPE)
  htmlIframeElements.delete(SHAPE)
}

// 1. LATE REGISTRATION — the frame has not loaded anything yet when the reload
//    subscribes. This is the case the old element-listener could not cover at
//    all: with no element registered it returned null and waited for nothing.
reset()
{
  const { loaded } = whenHtmlIframeLoaded(SHAPE, '/doc.html?v=2')
  equal(await outcome(loaded), 'pending', 'late registration: pending before the load')
  equal(htmlIframeLoadWaiterCount(SHAPE), 1, 'late registration: waiter is registered')
  noteHtmlIframeLoaded(SHAPE, frame('/doc.html?v=2'))
  equal(await outcome(loaded), 'loaded', 'late registration: resolves LOADED when the frame reports it')
  equal(htmlIframeLoadWaiterCount(SHAPE), 0, 'late registration: waiter released')
}

// 2. ALREADY-FIRED LOAD — the requested document loaded before anyone
//    subscribed. An element listener attached now would wait out the timeout.
reset()
{
  noteHtmlIframeLoaded(SHAPE, frame('/doc.html?v=3'))
  const { loaded } = whenHtmlIframeLoaded(SHAPE, '/doc.html?v=3')
  equal(await outcome(loaded), 'loaded', 'already-fired: resolves loaded immediately')

  // CONTROL: it must not resolve immediately for a document that has NOT
  // loaded, or "resolve immediately" is the whole behaviour and case 1 is luck.
  const other = whenHtmlIframeLoaded(SHAPE, '/doc.html?v=4')
  equal(await outcome(other.loaded), 'pending', 'already-fired control: a different url stays pending')
  other.dispose()
}

// 3. OVERLAPPING RELOADS — a stale navigation completing must not satisfy a
//    later reload's wait. This is what a bare counter gets wrong.
reset()
{
  const first = whenHtmlIframeLoaded(SHAPE, '/doc.html?v=5')
  const second = whenHtmlIframeLoaded(SHAPE, '/doc.html?v=6')
  equal(htmlIframeLoadWaiterCount(SHAPE), 2, 'overlapping: both waiters registered')

  noteHtmlIframeLoaded(SHAPE, frame('/doc.html?v=5'))
  equal(await outcome(first.loaded), 'loaded', 'overlapping: the matching wait resolves')
  equal(await outcome(second.loaded), 'pending', 'overlapping: the LATER wait is not satisfied by an earlier load')
  equal(htmlIframeLoadWaiterCount(SHAPE), 1, 'overlapping: only the matched waiter was released')

  noteHtmlIframeLoaded(SHAPE, frame('/doc.html?v=6'))
  equal(await outcome(second.loaded), 'loaded', 'overlapping: the later wait resolves on its own document')
}

// 4. DISPOSAL — a waiter must not outlive the reload that made it, nor the
//    shape it belongs to.
reset()
{
  const { loaded, dispose } = whenHtmlIframeLoaded(SHAPE, '/doc.html?v=7')
  equal(htmlIframeLoadWaiterCount(SHAPE), 1, 'disposal: registered')
  dispose()
  equal(htmlIframeLoadWaiterCount(SHAPE), 0, 'disposal: dispose removes the waiter')
  equal(await outcome(loaded), 'cancelled', 'disposal: settles CANCELLED, not loaded')
  // CONTROL: a disposed waiter must not be turned into a load by a later
  // matching document — if it were, dispose would be decorative.
  noteHtmlIframeLoaded(SHAPE, frame('/doc.html?v=7'))
  equal(await outcome(loaded), 'cancelled', 'disposal control: a later matching load does not revive it')
}

// 5. SHAPE GONE — pending waits are released, and released as CANCELLED. This
//    is the one that bit: settling them as loaded made a shape deletion
//    indistinguishable from a finished reload, and the caller remapped on it.
reset()
{
  const { loaded } = whenHtmlIframeLoaded(SHAPE, '/doc.html?v=8')
  equal(await outcome(loaded), 'pending', 'shape gone: pending beforehand')
  disposeHtmlIframeLoadWaiters(SHAPE)
  equal(await outcome(loaded), 'cancelled', 'shape gone: released as CANCELLED, never as loaded')
  equal(htmlIframeLoadWaiterCount(SHAPE), 0, 'shape gone: nothing retained')
}

// 6. THE REAL URL SHAPES, copied from a measured reload rather than invented.
//    The rendered src carries a `_tldaShape` parameter the reload never asked
//    for, so whole-string equality never matches. Without keying on the reload
//    token this case fails and the notification is dead code that falls through
//    to its timeout — while cases 1-5, which build both sides themselves, all
//    still pass. That is exactly why this one is here.
reset()
{
  const requested: string = 'https://host.example:5210/docs/p/homework/week1-homework.html?_tldaReload=1789381083230'
  const loadedHref: string = 'https://host.example:5210/docs/p/homework/week1-homework.html?_tldaReload=1789381083230&_tldaShape=shape:qmd-anchor-page-0'
  equal(requested === loadedHref, false, 'real urls: the two strings genuinely differ')

  const { loaded } = whenHtmlIframeLoaded(SHAPE, requested)
  noteHtmlIframeLoaded(SHAPE, frame(loadedHref))
  equal(await outcome(loaded), 'loaded', 'real urls: the requested reload is recognised in the loaded document')

  // CONTROL: a DIFFERENT reload token on the same path must still not match, or
  // the normalisation has simply stopped discriminating.
  const other = whenHtmlIframeLoaded(SHAPE, 'https://host.example:5210/docs/p/homework/week1-homework.html?_tldaReload=1789381083231')
  equal(await outcome(other.loaded), 'pending', 'real urls control: a different reload token does not match')
  other.dispose()
}

reset()
console.log('htmlIframeLoadNotification: 6 cases pass')
