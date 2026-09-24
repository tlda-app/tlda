/**
 * Chat rows lay out in flow; estimated sizes live only in offscreen spacers.
 *
 * The anchored list used to absolutely position every row at a start summed
 * from measured-or-80px heights. Any height held above reality — a short row
 * sitting at the 80px default, a resolved activity row keeping a stale tall
 * height — pushed every start below it too low, accumulating from the origin,
 * until a tall thread painted onto the screen from truly offscreen. Static,
 * no input, nothing moving under the eye: the frame itself was wrong.
 *
 * So visible rows carry no computed position at all. They render in normal
 * flow at true heights; the model sums touch only the two spacers bracketing
 * the rendered window. A wrong estimate then shifts the window uniformly
 * instead of warping rows against each other, and measurement corrects it
 * without moving any visible row.
 *
 * This test renders AnchoredChatList and reads the resulting DOM: no inline
 * transform on any row, spacers present carrying exactly the model sums. Both
 * fail against the hand-positioned layout.
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The component imports its stylesheet the way the bundler expects. Node has
// no loader for that, so stand one in: the test is about the rendered DOM,
// not the styling, and without this the import fails before any assertion.
registerHooks({
  resolve(specifier, context, nextResolve) {
    // AnchoredChatList never touches the terminal; its module graph imports
    // xterm, whose node subpath exports nothing usable here. Stand in a stub
    // so the import succeeds and the list under test is the real one.
    if (specifier === 'xterm') {
      return {
        url: 'data:text/javascript,export class Terminal {}',
        shortCircuit: true,
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {}' }
    return nextLoad(url, context)
  },
})

const ESTIMATE = 80
const VIEWPORT_H = 600

test('anchored chat rows render in flow with model sums confined to spacers', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://tlda.test/', pretendToBeVisual: true })
  ;(dom.window as any).__TLDA_CONFIG__ = {
    name: 'testing',
    database: { http: 'https://tlda.test', ws: 'wss://tlda.test' },
    store: { http: 'https://tlda.test', ws: 'wss://tlda.test' },
    licenseKey: '',
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    Event: dom.window.Event,
    Blob: dom.window.Blob,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Mozilla/5.0 Chrome/125 Safari/537.36', maxTouchPoints: 0, sendBeacon: () => true },
  })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage })
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const timer = realSetInterval(...args)
    ;(timer as any).unref?.()
    return timer
  }) as typeof setInterval

  // Thirty short rows, one tall thread, five more shorts. Shorts are 26px of
  // real content against the 80px default — the overestimate that used to push
  // the thread's bottom too low.
  const items = [
    ...Array.from({ length: 30 }, (_, i) => ({ key: `s${i}` })),
    { key: 'thread' },
    ...Array.from({ length: 5 }, (_, i) => ({ key: `e${i}` })),
  ]
  const realHeights = new Map<string, number>()
  for (const item of items) realHeights.set(item.key, item.key === 'thread' ? 1500 : 26)

  // Every measured key, recorded where the component reads it: reconcile learns
  // a row's height from getBoundingClientRect, so the mock's reader set IS the
  // component's height map — including rows from transient windows the settled
  // DOM no longer shows.
  const seen = new Set<string>()
  // jsdom does no layout: report the scripted truth per row. offsetTop answers
  // the cumulative real heights above, which is what flow layout produces.
  Object.defineProperty(dom.window.Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element) {
      const key = this.getAttribute?.('data-chat-item-key') ?? ''
      const h = realHeights.get(key) ?? 0
      if (h > 0) seen.add(key)
      return { x: 0, y: 0, top: 0, left: 0, bottom: h, right: 400, width: 400, height: h, toJSON: () => ({}) }
    },
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) { return this.classList?.contains('fleet-chat-log-anchored') ? VIEWPORT_H : 0 },
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) { return realHeights.get(this.getAttribute?.('data-chat-item-key') ?? '') ?? 0 },
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      const key = this.getAttribute?.('data-chat-item-key') ?? ''
      const at = items.findIndex(item => item.key === key)
      if (at < 0) return 0
      let top = 0
      for (let i = 0; i < at; i++) top += realHeights.get(items[i].key) ?? 0
      return top
    },
  })

  const React = await import('react')
  ;(globalThis as any).React = React
  const { act, createElement } = React
  const { createRoot } = await import('react-dom/client')
  const { AnchoredChatList } = await import('../src/shapes/FleetChatShape.tsx')

  const expectedSpacers = () => {
    const rendered = [...document.querySelectorAll('.fleet-chat-anchored-slice .chat-row-wrap')]
      .map(el => el.getAttribute('data-chat-item-key') ?? '')
    assert.ok(rendered.length > 0, 'the window must render some rows')
    const modelHeight = (key: string) => seen.has(key) ? (realHeights.get(key) ?? ESTIMATE) : ESTIMATE
    const first = items.findIndex(item => item.key === rendered[0])
    const last = items.findIndex(item => item.key === rendered[rendered.length - 1])
    let top = 0
    for (let i = 0; i < first; i++) top += modelHeight(items[i].key)
    let bottom = 0
    for (let i = last + 1; i < items.length; i++) bottom += modelHeight(items[i].key)
    return { top, bottom }
  }
  const assertFlowContract = () => {
    const rows = [...document.querySelectorAll('.fleet-chat-anchored-slice .chat-row-wrap')] as HTMLElement[]
    assert.ok(rows.length > 0, 'the window must render some rows')
    for (const row of rows) {
      assert.equal(
        row.style.transform, '',
        `row ${row.getAttribute('data-chat-item-key')} must carry no computed position (flow, not translateY)`,
      )
    }
    const expected = expectedSpacers()
    const top = document.querySelector('[data-anchor-spacer="top"]') as HTMLElement | null
    const bottom = document.querySelector('[data-anchor-spacer="bottom"]') as HTMLElement | null
    assert.ok(top, 'a top spacer must carry the model heights above the window')
    assert.ok(bottom, 'a bottom spacer must carry the model heights below the window')
    assert.equal(top.style.height, `${expected.top}px`, 'top spacer carries exactly the model sum above')
    assert.equal(bottom.style.height, `${expected.bottom}px`, 'bottom spacer carries exactly the model sum below')
  }

  const root = createRoot(document.getElementById('root')!)
  await act(async () => {
    root.render(createElement(AnchoredChatList as any, {
      items,
      resetKey: 'flow-test',
      renderItem: (item: { key: string }) => createElement('div', { className: 'test-row-body' }, item.key),
      onStartReached: () => false,
      initialHistoryWindow: 5,
    }))
  })
  assertFlowContract()

  // Off the tail, where the reader lives: scroll up and the contract holds in
  // the new window too.
  const scroller = document.querySelector('.fleet-chat-log-anchored') as HTMLElement
  await act(async () => {
    scroller.scrollTop = 10_000_000 - 2000
    scroller.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }))
  })
  assertFlowContract()

  await act(async () => root.unmount())
})
