/**
 * A mark's anchor has to survive the page's own scripts.
 *
 * A marking anchor names an element by a path, and the path is read back later —
 * after a reopen, and in the student's copy. Between those two moments the
 * page's own libraries insert nodes: anchorjs adds a link inside every heading,
 * Quarto and clipboard add a copy button to every code block, tippy appends to
 * the body. A path of plain child indices shifts under all of that. Measured on
 * the real chapter: 40 such insertions broke 22 of 304 plain keys and 0 of the
 * tag-qualified ones.
 *
 * The SVG case is here because it is the one that bit: `tagName` is `DIV` in
 * HTML and `clipPath` in SVG, and normalising it broke 17 keys — every one of
 * them inside an inline plot.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { anchorContexts, anchorKey, resolveAnchorKey } from '../src/classroom/contentAnchor'
import { htmlIframeElements } from '../src/htmlIframeRegistry'

const page = () => new JSDOM(`<!doctype html><html><body>
  <section id="intro">
    <p>first</p>
    <p>second</p>
    <div class="callout">
      <div class="callout-header">Solution</div>
      <div class="callout-1-contents collapse"><p>hidden one</p><p>hidden two</p></div>
    </div>
  </section>
  <section id="figure">
    <h2>Plot</h2>
    <svg><g><clipPath><rect></rect></clipPath><path></path></g></svg>
  </section>
</body></html>`).window.document

test('a key resolves back to the element it was taken from', () => {
  const doc = page()
  for (const el of doc.querySelectorAll('p, h2, div, rect, path')) {
    assert.equal(resolveAnchorKey(anchorKey(el, doc), doc), el)
  }
})

test('a key is anchored at the nearest id, not at the document root', () => {
  const doc = page()
  const second = doc.querySelectorAll('#intro p')[1]
  assert.ok(anchorKey(second, doc).startsWith('#intro/'))
})

test('an SVG element keeps its tag case', () => {
  const doc = page()
  const rect = doc.querySelector('rect')!
  const key = anchorKey(rect, doc)
  // Not `clippath[0]`: lowercasing here is what broke the inline plots.
  assert.ok(key.includes('clipPath['), `expected camelCase clipPath in ${key}`)
  assert.equal(resolveAnchorKey(key, doc), rect)
})

test('a key survives the insertions the page makes after load', () => {
  const doc = page()
  const target = doc.querySelectorAll('#intro p')[1]
  const key = anchorKey(target, doc)

  // anchorjs into the heading, a copy button as the FIRST child of a section —
  // the case that shifts every following index — and a tooltip on the body.
  const link = doc.createElement('a')
  link.className = 'anchorjs-link'
  doc.querySelector('h2')!.appendChild(link)
  const button = doc.createElement('button')
  button.className = 'code-copy-button'
  const intro = doc.getElementById('intro')!
  intro.insertBefore(button, intro.firstChild)
  doc.body.appendChild(doc.createElement('div'))

  assert.equal(resolveAnchorKey(key, doc), target)
})

test('the control: a plain child-index path would NOT survive those insertions', () => {
  // Without this the test above proves nothing — it would pass for a key that
  // happened not to be disturbed. A plain index must actually break.
  const doc = page()
  const target = doc.querySelectorAll('#intro p')[1]
  const plainIndex = Array.prototype.indexOf.call(target.parentElement!.children, target)

  const intro = doc.getElementById('intro')!
  const button = doc.createElement('button')
  button.className = 'code-copy-button'
  intro.insertBefore(button, intro.firstChild)

  assert.notEqual(intro.children[plainIndex], target)
  assert.equal(resolveAnchorKey(anchorKey(target, doc), doc), target)
})

test('an unresolvable key is null rather than a wrong element', () => {
  const doc = page()
  assert.equal(resolveAnchorKey('#nope/P[0]', doc), null)
  assert.equal(resolveAnchorKey('#intro/P[99]', doc), null)
})

// --- the badge observer's self-exclusion ---
//
// Driven by a REAL MutationObserver over real DOM writes, not by fabricated
// records. The first version of these tests hand-built a `characterData` record
// with an Element target, which cannot occur — a `characterData` record's target
// is a Text node — so it asserted against a shape the browser never produces.
//
// The guard itself has already been wrong once, in the direction that is hard to
// see: an attribute record carries EMPTY node lists, so a fall-through to
// `[...added, ...removed].every(isBadge)` was vacuously true and swallowed the
// `.collapse` class change this hook exists to react to.

import { awaitPendingMounts, collectHiddenPanels, createFrameScheduler, pruneRetiredObservers, isOwnBadgeWrite } from '../src/classroom/useContentAnchoredMarks'

const BADGE = 'data-tlda-feedback-badge'

/** Capture what an observer configured exactly like the hook's actually emits. */
async function recordsFor(mutate: (doc: Document) => void) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="callout">
      <div class="callout-header">Solution</div>
      <div class="collapse"><p>hidden</p></div>
    </div>
  </body></html>`)
  const doc = dom.window.document
  const seen: MutationRecord[] = []
  const observer = new dom.window.MutationObserver(rs => { seen.push(...rs) })
  observer.observe(doc.body, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'],
  })
  mutate(doc)
  await new Promise(resolve => setTimeout(resolve, 0))
  observer.disconnect()
  return { doc, records: seen }
}

const addBadge = (doc: Document, text = '1 comment') => {
  const badge = doc.createElement('span')
  badge.setAttribute(BADGE, '1')
  badge.textContent = text
  doc.querySelector('.callout-header')!.appendChild(badge)
  return badge
}

test('a real collapse class change is NOT our own badge write', async () => {
  const { records } = await recordsFor(doc => {
    doc.querySelector('.collapse')!.classList.add('show')
  })
  assert.ok(records.length > 0, 'the observer must have seen the class change')
  assert.equal(isOwnBadgeWrite(records), false)
})

test('really adding a badge IS our own write', async () => {
  const { records } = await recordsFor(doc => { addBadge(doc) })
  assert.ok(records.length > 0)
  assert.equal(isOwnBadgeWrite(records), true)
})

test('really relabelling a badge IS our own write', async () => {
  const dom = new JSDOM(`<!doctype html><html><body><div class="callout-header"></div></body></html>`)
  const doc = dom.window.document
  const badge = addBadge(doc, '1 comment')
  const seen: MutationRecord[] = []
  const observer = new dom.window.MutationObserver(rs => { seen.push(...rs) })
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] })
  badge.textContent = '2 comments'
  await new Promise(resolve => setTimeout(resolve, 0))
  observer.disconnect()
  assert.ok(seen.length > 0, 'relabelling must produce a record the guard has to classify')
  assert.equal(isOwnBadgeWrite(seen), true)
})

test('an empty batch is not ours — it must not suppress a placement', () => {
  assert.equal(isOwnBadgeWrite([]), false)
})

test('a real mixed batch is not ours: one true reflow is enough', async () => {
  const { records } = await recordsFor(doc => {
    addBadge(doc)
    doc.querySelector('.collapse')!.classList.add('show')
  })
  assert.ok(records.length > 1)
  assert.equal(isOwnBadgeWrite(records), false)
})

// --- own placement write vs a real incoming mark ---
//
// This distinction replaced a `source: 'user'` filter that looked equivalent and
// was not: a Return landing while the student has the document open arrives
// through TLSyncClient, which applies it via mergeRemoteChanges — so it is
// 'remote', exactly like this hook's own writes. Filtering by source silenced the
// one event the student side exists to react to. The filter is now on WHAT
// changed, and these pin both directions.

import { isDerivedPlacementOnly } from '../src/classroom/useContentAnchoredMarks'

const mark = (over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) => ({
  typeName: 'shape', type: 'draw', id: 'shape:m1', x: 10, y: 100, opacity: 1,
  meta: { contentAnchor: { top: { key: '#a', frac: 0 }, bottom: { key: '#b', frac: 1 } } },
  props: { scaleY: 1, color: 'red', segments: [], ...props },
  ...over,
})

test('a pure placement write is recognised as our own', () => {
  const before = mark()
  // Built the way `placeAll` builds it — spread the record and its props — so
  // unchanged fields keep their identity. A fixture that rebuilds `props` from
  // scratch gives every array a new reference and fails for a reason the
  // production path never has.
  const after = { ...before, y: 400, opacity: 0, props: { ...before.props, scaleY: 2.5 } }
  assert.equal(isDerivedPlacementOnly(before, after), true)
})

test('a changed anchor is NOT our own write', () => {
  const before = mark()
  // A new meta object: the anchor itself may have changed, so this must NOT be
  // treated as our own write.
  const after = { ...before, y: 400, meta: { ...before.meta } }
  assert.equal(isDerivedPlacementOnly(before, after), false)
})

test('a changed x is NOT our own write — we never write x', () => {
  const before = mark()
  const after = { ...before, x: 999 }
  assert.equal(isDerivedPlacementOnly(before, after), false)
})

test('changed geometry is NOT our own write', () => {
  const before = mark()
  const after = { ...before, props: { ...before.props, segments: [{ type: 'free', path: 'zz' }] } }
  assert.equal(isDerivedPlacementOnly(before, after), false)
})

test('a non-mark record is never our own write', () => {
  const before = { typeName: 'shape', type: 'html-page', id: 'shape:p', y: 0, props: {}, meta: {} }
  const after = { ...before, y: 5 }
  assert.equal(isDerivedPlacementOnly(before, after), false)
})

// --- the badge renderer ---
//
// The one part of this diff with no coverage at all, and it has never been seen
// in a browser: no mark has yet been inside a closed collapsible on any surface
// tested. These are DEVELOPMENT evidence that it does what it claims, not
// acceptance of Skip's ruling — that needs the composed UI.

import { renderFeedbackBadges } from '../src/classroom/useContentAnchoredMarks'

const BADGE_SEL = '[data-tlda-feedback-badge]'

function calloutDoc(n = 2) {
  const blocks = Array.from({ length: n }, (_, i) => `
    <div class="callout">
      <div class="callout-header">Solution ${i + 1}</div>
      <div class="callout-${i + 1}-contents collapse"><p id="p${i + 1}">hidden ${i + 1}</p></div>
    </div>`).join('')
  return new JSDOM(`<!doctype html><html><body>${blocks}</body></html>`).window.document
}

const panels = (doc: Document) => [...doc.querySelectorAll('.collapse')]
const badges = (doc: Document) => [...doc.querySelectorAll(BADGE_SEL)]

test('a hidden mark badges its own solution, on the header', () => {
  const doc = calloutDoc()
  renderFeedbackBadges(doc, new Map([[panels(doc)[0], new Set(['shape:a'])]]))
  const found = badges(doc)
  assert.equal(found.length, 1)
  assert.ok(found[0].parentElement?.classList.contains('callout-header'))
  assert.equal(found[0].textContent, '1 comment')
})

test('the count is DISTINCT MARKS, and two marks read as plural', () => {
  const doc = calloutDoc()
  renderFeedbackBadges(doc, new Map([[panels(doc)[0], new Set(['shape:a', 'shape:b'])]]))
  assert.equal(badges(doc)[0].textContent, '2 comments')
})

test('one mark anchored twice into the same solution counts ONCE', () => {
  // Both ends of one diagonal land in the same closed callout. The Set is keyed
  // on the shape id precisely so this is 1, not 2.
  const doc = calloutDoc()
  const marks = new Set<string>()
  marks.add('shape:a')   // top anchor
  marks.add('shape:a')   // bottom anchor, same mark
  renderFeedbackBadges(doc, new Map([[panels(doc)[0], marks]]))
  assert.equal(badges(doc)[0].textContent, '1 comment')
})

test('a mark spanning two closed solutions badges BOTH', () => {
  const doc = calloutDoc()
  renderFeedbackBadges(doc, new Map([
    [panels(doc)[0], new Set(['shape:a'])],
    [panels(doc)[1], new Set(['shape:a'])],
  ]))
  assert.equal(badges(doc).length, 2)
})

test('reconciles to zero when the last mark goes — the case that was broken', () => {
  const doc = calloutDoc()
  renderFeedbackBadges(doc, new Map([[panels(doc)[0], new Set(['shape:a'])]]))
  assert.equal(badges(doc).length, 1)
  // An empty map is a real state to render, not a reason to render nothing.
  renderFeedbackBadges(doc, new Map())
  assert.equal(badges(doc).length, 0, 'a stale badge claims feedback that is gone')
})

test('re-rendering the same state does not duplicate or churn the label', () => {
  const doc = calloutDoc()
  const hidden = new Map([[panels(doc)[0], new Set(['shape:a'])]])
  renderFeedbackBadges(doc, hidden)
  const first = badges(doc)[0]
  renderFeedbackBadges(doc, hidden)
  assert.equal(badges(doc).length, 1)
  assert.equal(badges(doc)[0], first, 'the badge element must be reused, not replaced')
})

test('a panel with no callout ancestor gets no badge rather than throwing', () => {
  const doc = new JSDOM(`<!doctype html><html><body><div class="collapse"><p>x</p></div></body></html>`).window.document
  const orphan = doc.querySelector('.collapse')!
  renderFeedbackBadges(doc, new Map([[orphan, new Set(['shape:a'])]]))
  assert.equal(badges(doc).length, 0)
})

/**
 * Two mounts that disagree, and a governing view that is not there yet.
 *
 * A page shape mounts once per viewport — the grading surface mounts the
 * submission three times — and the copies disagree about which solutions are
 * open, because collapse state is per document. A mark has ONE opacity, so one
 * view has to decide, and measured on `replay-a` the wrong one did: the badge
 * rendered into the main editor's copy and the mark stayed hidden while the
 * solution was open in the pane the instructor was looking at.
 *
 * These are the two cases a single-document test can never reach, which is why
 * the 23 tests above all passed while that was happening.
 */
const mountedPage = () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <section id="paneA" data-shape-id="shape:page-0"><iframe></iframe></section>
    <section id="paneB" data-shape-id="shape:page-0"><iframe></iframe></section>
    <section id="paneC"></section>
  </body></html>`)
  const g = globalThis as any
  const priorDocument = g.document
  const priorWindow = g.window
  g.document = dom.window.document
  g.window = dom.window
  const frames = Array.from(dom.window.document.querySelectorAll('iframe'))
  for (const frame of frames) {
    const doc = (frame as any).contentDocument
    doc.body.innerHTML = '<p style="width:800px">content</p>'
    // A width of zero reads as "not laid out" and the context is dropped, so the
    // mounts need a measurable document or this fixture tests nothing.
    Object.defineProperty(doc.body, 'scrollWidth', { value: 800, configurable: true })
  }
  // The registry names ONE mount — here, the first. That is what a caller who
  // states no policy gets, and it is deliberately NOT pane B, so "pane B governs"
  // cannot be satisfied by the registry.
  htmlIframeElements.set('shape:page-0', frames[0] as any)
  return {
    dom,
    docA: (frames[0] as any).contentDocument as Document,
    docB: (frames[1] as any).contentDocument as Document,
    paneB: dom.window.document.getElementById('paneB')!,
    paneC: dom.window.document.getElementById('paneC')!,
    restore: () => {
      htmlIframeElements.delete('shape:page-0')
      g.document = priorDocument
      g.window = priorWindow
    },
  }
}

const PAGE_SHAPE = { id: 'shape:page-0', x: 0, y: 0, props: { w: 800 } }

test('with two mounts, the caller\'s view governs — not whichever came first', () => {
  const fixture = mountedPage()
  try {
    const { all, governing } = anchorContexts(PAGE_SHAPE, fixture.paneB)
    assert.equal(all.length, 2, 'both mounts are enumerated, so badges reach both')
    assert.equal(governing?.doc, fixture.docB, 'the governing mount is pane B, not the first in the DOM')

    // The control: without it, "pane B governs" could just be DOM order or the
    // registry agreeing by luck. Stating no policy selects the REGISTRY's mount,
    // which is A — so the assertion above is not free.
    const noPolicy = anchorContexts(PAGE_SHAPE)
    assert.equal(noPolicy.governing?.doc, fixture.docA)
    assert.notEqual(noPolicy.governing?.doc, fixture.docB)
  } finally { fixture.restore() }
})

test('a governing view that is not mounted yields NULL, never a borrowed mount', () => {
  const fixture = mountedPage()
  try {
    // paneC is a real element of this surface that holds no mount of this page —
    // the state during a mount replacement, when the pane exists and its iframe
    // has not attached.
    const { all, governing } = anchorContexts(PAGE_SHAPE, fixture.paneC)
    assert.equal(all.length, 2, 'the other mounts are still enumerated for badges')
    assert.equal(
      governing, null,
      'no match must mean NULL so the caller preserves the mark; borrowing another ' +
      'mount is how a mark gets hidden by a document the reader cannot see',
    )
  } finally { fixture.restore() }
})

/**
 * `undefined` and `null` are different answers from a caller.
 *
 * The first version wrote `if (!governingRoot)`, which treated "my named view is
 * not mounted right now" exactly like "I state no policy" — and fell back to an
 * arbitrary mount, which is the defect the whole change exists to remove. The
 * two must not collapse, and the hook must not collapse them on the way in
 * either.
 */
test('an unavailable named view (null) is NOT the same as no policy (undefined)', () => {
  const fixture = mountedPage()
  try {
    const noPolicy = anchorContexts(PAGE_SHAPE)
    const unavailable = anchorContexts(PAGE_SHAPE, null)

    assert.equal(
      noPolicy.governing?.doc, fixture.docA,
      'no policy keeps the pre-existing behaviour: the REGISTRY\'s document, with no ' +
      'all[0] tail — a tail would hand an arbitrary mount to a caller that asked for none',
    )
    assert.equal(
      unavailable.governing, null,
      'a named view that is not mounted must yield NULL so the caller preserves the mark',
    )
    // Both still enumerate every mount, because badges belong in all of them
    // regardless of who governs.
    assert.equal(noPolicy.all.length, 2)
    assert.equal(unavailable.all.length, 2)
  } finally { fixture.restore() }
})

/**
 * A retired document's observer has to be disconnected when its mount goes, not
 * at hook teardown.
 *
 * Flicking to the next student swaps a pane's iframe. Attaching only ever added,
 * so each student left a live MutationObserver on a document nobody renders —
 * each still firing, each still scheduling a placement pass.
 */
test('mounts that go away have their observers disconnected, and live ones do not', () => {
  const kept = new JSDOM('<!doctype html><p>kept</p>').window.document
  const retired = new JSDOM('<!doctype html><p>retired</p>').window.document
  const calls: string[] = []
  const observers = new Map<Document, { disconnect(): void }>([
    [kept, { disconnect: () => calls.push('kept') }],
    [retired, { disconnect: () => calls.push('retired') }],
  ])

  const gone = pruneRetiredObservers(observers, new Set([kept]))

  assert.deepEqual(calls, ['retired'], 'only the retired document is disconnected')
  assert.deepEqual(gone, [retired])
  assert.ok(observers.has(kept), 'the live document keeps observing')
  assert.equal(observers.has(retired), false, 'and the retired one is dropped from the map')

  // The control: with every document live, nothing is disconnected — so the
  // assertion above is about retirement, not about the function disconnecting
  // whatever it is handed.
  const stillCalls: string[] = []
  const allLive = new Map<Document, { disconnect(): void }>([
    [kept, { disconnect: () => stillCalls.push('kept') }],
  ])
  pruneRetiredObservers(allLive, new Set([kept]))
  assert.deepEqual(stillCalls, [], 'nothing retired means nothing disconnected')
})

/**
 * A mount replaced with a frame still pending must not silence placement forever.
 *
 * The scheduler used to take its id from whichever iframe Window triggered it.
 * That window dies when its pane swaps iframes — every flick to the next student
 * — so the callback never runs, the pending flag stays set, and every later
 * placement is dropped by the `if (pending) return` guard. No error, no retry: a
 * mark simply stops following its content for the rest of the session.
 */
const fakeView = () => {
  const queued: Array<() => void> = []
  let next = 1
  return {
    requestAnimationFrame(cb: () => void) { queued.push(cb); return next++ },
    cancelAnimationFrame(_id: number) { queued.length = 0 },
    fire() { const run = queued.splice(0); for (const cb of run) cb() },
    /** What a replaced iframe does: the frame is never delivered. */
    destroy() { queued.length = 0 },
    pendingCount: () => queued.length,
  }
}

test('a scheduler on a window that is replaced mid-frame still recovers', () => {
  // THE DEFECT, reproduced: a scheduler owned by the doomed iframe window.
  const doomed = fakeView()
  const onDoomed = createFrameScheduler(doomed)
  let ranOnDoomed = 0
  onDoomed.schedule(() => { ranOnDoomed++ })
  doomed.destroy()                       // the pane swaps its iframe
  assert.equal(ranOnDoomed, 0, 'the pending callback died with its window')
  assert.equal(onDoomed.isPending(), true, 'and the scheduler is stuck pending')
  onDoomed.schedule(() => { ranOnDoomed++ })
  doomed.fire()
  assert.equal(ranOnDoomed, 0, 'so every later placement is silently dropped — the bug')

  // THE FIX: owned by the outer window, which outlives the mount.
  const outer = fakeView()
  const scheduler = createFrameScheduler(outer)
  let ran = 0
  scheduler.schedule(() => { ran++ })
  // A mount is replaced while that frame is pending. The outer window is untouched.
  outer.fire()
  assert.equal(ran, 1, 'the pending frame still fires')
  assert.equal(scheduler.isPending(), false, 'and the flag clears')
  scheduler.schedule(() => { ran++ })
  outer.fire()
  assert.equal(ran, 2, 'so placement keeps working after the replacement')
})

test('coalescing holds, and cancel releases the pending flag', () => {
  const view = fakeView()
  const scheduler = createFrameScheduler(view)
  let ran = 0
  scheduler.schedule(() => { ran++ })
  scheduler.schedule(() => { ran++ })
  scheduler.schedule(() => { ran++ })
  assert.equal(view.pendingCount(), 1, 'many records, one frame')
  view.fire()
  assert.equal(ran, 1)

  scheduler.schedule(() => { ran++ })
  scheduler.cancel()
  assert.equal(scheduler.isPending(), false, 'teardown must not leave it pending')
  view.fire()
  assert.equal(ran, 1, 'and the cancelled callback does not run')
})

/**
 * Badges are per document, and controlled rects are enough to prove the wiring.
 *
 * jsdom has no layout — every rect is zero — so an open mount and a closed one
 * are indistinguishable by default, which is why the earlier tests could not see
 * this. Stubbing `getBoundingClientRect` supplies exactly the discrimination the
 * branch needs: a resolvable anchor in one document and not in the other. It does
 * NOT replace layout acceptance in a browser.
 */
const mountWithAnchor = (openPanel: boolean) => {
  const dom = new JSDOM(`<!doctype html><html><body><div id="host">
    <div class="callout">
      <div class="callout-header">Solution</div>
      <div class="callout-collapse collapse"><p id="target">answer</p></div>
    </div>
  </div></body></html>`)
  const doc = dom.window.document
  const target = doc.getElementById('target')!
  // A closed panel's content has no box; an open one does.
  const rect = openPanel
    ? { top: 100, bottom: 140, height: 40, left: 0, right: 500, width: 500 }
    : { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 }
  ;(target as any).getBoundingClientRect = () => rect
  Object.defineProperty(doc.body, 'scrollWidth', { value: 800, configurable: true })
  return { doc, target }
}

test('each document decides its own badge, and an open mount does not suppress a closed one', () => {
  const openMount = mountWithAnchor(true)
  const closedMount = mountWithAnchor(false)
  const ctx = (doc: Document) => ({ doc, shapeX: 0, shapeY: 0, scale: 1, scrollX: 0, scrollY: 0 })
  const anchor = { top: { key: '#target', frac: 0 }, bottom: { key: '#target', frac: 1 } }

  const noted: Array<{ doc: Document; panel: string }> = []
  collectHiddenPanels(
    [ctx(openMount.doc), ctx(closedMount.doc)],
    anchor as any,
    'shape:mark',
    (doc, panel) => noted.push({ doc, panel: panel.className }),
  )

  const docsNoted = new Set(noted.map(entry => entry.doc))
  assert.equal(
    docsNoted.has(closedMount.doc), true,
    'the CLOSED mount badges — its reader cannot see the mark',
  )
  assert.equal(
    docsNoted.has(openMount.doc), false,
    'the OPEN mount does not — the mark is visible there, and a badge would be a lie',
  )
  assert.ok(noted.every(entry => entry.panel.includes('collapse')))
})

/**
 * An iframe that is still loading has a documentElement and no body.
 *
 * Enumerating mounts from the DOM reaches documents mid-load; the single
 * registry document never was one. The old guard took
 * `max(body?.scrollWidth, documentElement.scrollWidth)`, so a body-less document
 * with a sized documentElement passed as a usable context — and the first thing
 * the caller does is `observer.observe(doc.body)`, which threw
 * `parameter 1 is not of type 'Node'` and took ClassroomGradingSurface to its
 * error boundary. The whole marking surface showed "Something went wrong".
 */
test('a document with no body yields no context, however wide its documentElement', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const doc = dom.window.document
  // Exactly the shape of a loading iframe: documentElement reports a width, and
  // there is no body.
  Object.defineProperty(doc.documentElement, 'scrollWidth', { value: 1200, configurable: true })
  Object.defineProperty(doc, 'body', { value: null, configurable: true })

  const g = globalThis as any
  const prior = g.document
  g.document = dom.window.document
  try {
    htmlIframeElements.set('shape:loading', { contentDocument: doc } as any)
    const { all, governing } = anchorContexts({ id: 'shape:loading', x: 0, y: 0, props: { w: 800 } })
    assert.equal(governing, null, 'no body means no usable context')
    assert.equal(all.length, 0, 'and it is not offered for badge work either')
  } finally {
    htmlIframeElements.delete('shape:loading')
    g.document = prior
  }
})

/**
 * The ready transition: a mount skipped while loading must be picked up when it
 * loads, and only then.
 *
 * Skipping a not-yet-ready iframe stops the crash. On its own it would be a
 * different bug — that mount is where a reader will be looking a moment later,
 * and nothing would ever place its marks or badge its solutions. `load` is the
 * document's own notification, so this is a wait, not a poll.
 */
test('a not-ready mount is picked up on its own load, once, and not before', () => {
  const dom = new JSDOM('<!doctype html><body><iframe id="a"></iframe><iframe id="b"></iframe></body>')
  const a = dom.window.document.getElementById('a') as any
  const b = dom.window.document.getElementById('b') as any
  const awaiting = new Map<any, () => void>()
  let ready = 0

  assert.equal(awaitPendingMounts([a, b], awaiting, () => { ready++ }), 2)
  assert.equal(ready, 0, 'nothing fires merely from waiting')

  // A repeated pass must not stack a second listener on the same frame.
  assert.equal(awaitPendingMounts([a, b], awaiting, () => { ready++ }), 0, 'no duplicates')

  a.dispatchEvent(new dom.window.Event('load'))
  assert.equal(ready, 1, 'the frame that loaded reports once')
  assert.equal(awaiting.has(a), false, 'and stops being awaited')
  assert.equal(awaiting.has(b), true, 'while the other keeps waiting')

  b.dispatchEvent(new dom.window.Event('load'))
  assert.equal(ready, 2)

  // `once` — a second load from the same frame must not re-fire a removed handler.
  a.dispatchEvent(new dom.window.Event('load'))
  assert.equal(ready, 2, 'the listener was one-shot')

  // And it can be re-armed deliberately, which is what a replaced iframe needs.
  assert.equal(awaitPendingMounts([a], awaiting, () => { ready++ }), 1)
  a.dispatchEvent(new dom.window.Event('load'))
  assert.equal(ready, 3)
})
