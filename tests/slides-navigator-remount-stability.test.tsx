/**
 * A SlidesNavigator re-render with an equal-content `document` prop must not
 * reset the deck.
 *
 * The navigator's mount effect depends on the `document` prop identity, and
 * the parent's presentationDocument memo used to recompute on every render
 * (presentationRoute returned a fresh object per call). So any ambient parent
 * re-render re-ran "initial navigation" and snapped a fix-era deck back to
 * 1/31 — the story-2 nondeterministic counter resets (Sep 24 verdict: resets
 * on confirmed clicks AND with no click at all, oscillation 1–8, same code
 * behaving differently across loads). This test re-renders with a
 * new-identity equal-content document — exactly what the churned memo handed
 * down — and requires position and camera to survive it.
 *
 * Opaque origin on purpose: sessionStorage throws, so the per-tab resume mask
 * cannot hide the reset. The invariant must hold without storage.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

function deckDocument() {
  return {
    name: 'qtm285-book',
    format: 'slides',
    pages: [{ shapeId: 'shape:deck', bounds: { x: 0, y: 0 } }],
    deckLayout: {
      rects: [
        { x: 0, y: 0, width: 960, height: 640, indexh: 0, indexv: 0 },
        { x: 1000, y: 0, width: 960, height: 640, indexh: 1, indexv: 0 },
        { x: 2000, y: 0, width: 960, height: 640, indexh: 2, indexv: 0 },
      ],
    },
  }
}

test('equal-content document prop keeps deck position and camera', async () => {
  const { JSDOM } = await import('jsdom')
  // No url: opaque origin, sessionStorage throws — the resume mask is off.
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true })
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

  const React = await import('react')
  ;(globalThis as any).React = React
  const { act, createElement } = React
  const { createRoot } = await import('react-dom/client')
  const { SlidesNavigator } = await import('../src/SlidesNavigator.tsx')

  const cameraCalls: Array<{ target: unknown; opts: unknown }> = []
  const editor = {
    getViewportScreenBounds: () => ({ width: 1200, height: 800 }),
    setCamera: (target: unknown, opts: unknown) => { cameraCalls.push({ target, opts }) },
    store: { get: (_id: string) => null },
  }
  const counterText = () =>
    (document.querySelector('.slides-nav-counter')?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const clickFirstNext = async () => {
    const next = document.querySelector('button[aria-label="Next slide"]') as HTMLElement | null
    assert.ok(next, 'a Next control must exist')
    await act(async () => { next.click() })
  }

  const root = createRoot(document.getElementById('root')!)
  await act(async () => {
    root.render(createElement(SlidesNavigator as any, { editor, document: deckDocument() }))
  })
  assert.equal(counterText(), '1 / 3')

  await clickFirstNext()
  assert.equal(counterText(), '2 / 3')

  // The churned parent memo handed down a fresh object per render: same deck,
  // new identity. Position and camera must survive that.
  cameraCalls.length = 0
  await act(async () => {
    root.render(createElement(SlidesNavigator as any, { editor, document: deckDocument() }))
  })
  assert.equal(counterText(), '2 / 3', 'an identity-only document prop must not reset the counter')
  assert.equal(cameraCalls.length, 0, 'an identity-only document prop must not re-snap the camera')

  // And the navigator still works afterwards.
  await clickFirstNext()
  assert.equal(counterText(), '3 / 3')

  await act(async () => root.unmount())
})
