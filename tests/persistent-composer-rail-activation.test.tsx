import assert from 'node:assert/strict'
import test from 'node:test'

test('captured pointer release plus synthesized click commits once across composer toggle states', async () => {
  const handlesBeforeMount = new Set(process._getActiveHandles())
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<div id="root"></div>')
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    fetch: async () => new Response('{}', { status: 200 }),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { PersistentCornerButtonSlider } = await import('../src/CornerButtonSlider')
  const transitions: string[] = []
  let state = 'dm-quiet'
  const root = createRoot(document.getElementById('root')!)
  const advance = (action: string) => {
    transitions.push(`${action}:${state}`)
    state = action === 'traffic'
      ? ({ 'dm-quiet': 'dm', dm: 'agent', agent: 'dm-quiet' } as Record<string, string>)[state]
      : state === 'terminal-off' ? 'terminal-pinned' : 'terminal-off'
  }
  await act(async () => root.render(createElement(PersistentCornerButtonSlider, { onSelect: advance },
    createElement('button', { 'data-composer-rail-action': 'traffic', 'data-composer-rail-label': 'Traffic', onClick: e => {
      if (e.detail === 0) advance('traffic')
    } }, 'Traffic'))))
  const rail = document.querySelector('.persistent-corner-button-slider') as HTMLElement
  const button = document.querySelector('button')!
  Object.assign(rail, { setPointerCapture() {} })
  Object.assign(document, { elementsFromPoint: () => [button] })
  for (const initial of ['dm-quiet', 'dm', 'agent', 'terminal-off', 'terminal-pinned']) {
    for (const type of ['mouse', 'touch', 'pen']) {
      state = initial
      transitions.length = 0
      button.dataset.composerRailAction = initial.startsWith('terminal') ? 'terminal-agent' : 'traffic'
      const event = (name: string) => Object.assign(new dom.window.MouseEvent(name, { bubbles: true, clientX: 10, clientY: 10, button: 0 }), { pointerId: 1, pointerType: type })
      await act(async () => { rail.dispatchEvent(event('pointerdown')); rail.dispatchEvent(event('pointerup')); button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 })) })
      assert.equal(transitions.length, 1, `${initial} ${type}`)
    }
  }
  state = 'dm-quiet'
  transitions.length = 0
  button.dataset.composerRailAction = 'traffic'
  await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 0 })))
  assert.deepEqual(transitions, ['traffic:dm-quiet'], 'keyboard/programmatic click')
  await act(async () => root.unmount())
  dom.window.close()
  for (const handle of process._getActiveHandles()) {
    if (!handlesBeforeMount.has(handle) && handle.constructor.name === 'MessagePort') {
      (handle as { close(): void }).close()
    }
  }
})
