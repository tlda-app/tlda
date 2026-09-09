import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'xterm') {
      return { shortCircuit: true, url: 'data:text/javascript,export class Terminal {}' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' }
    return nextLoad(url, context)
  },
})

test('mounted standalone chat commits through the latest parent callback and survives recreation', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
  Reflect.set(dom.window, '__TLDA_CONFIG__', {
    name: 'test',
    database: { http: 'http://localhost', ws: 'ws://localhost' },
    store: { http: 'http://localhost', ws: 'ws://localhost' },
    licenseKey: '',
  })
  const previousGlobals = new Map<string, unknown>()
  for (const [key, value] of Object.entries({
    window: dom.window,
    React,
    document: dom.window.document,
    navigator: dom.window.navigator,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    PointerEvent: dom.window.PointerEvent ?? dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
    WebSocket: class extends dom.window.EventTarget {
      static OPEN = 1
      readyState = 1
      send() {}
      close() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previousGlobals.set(key, Reflect.get(globalThis, key))
    Reflect.set(globalThis, key, value)
  }

  try {
    const { StandaloneChatPanel } = await import('../src/fleet/StandaloneChatPanel')
    const container = document.getElementById('root')!
    const root = createRoot(container)
    const filterA = [[['from', 'agent-a']]] as [string, string][][]
    const filterB = [[['from', 'agent-b']]] as [string, string][][]
    let parentA = filterA
    let parentB = filterB

    await act(async () => {
      root.render(<StandaloneChatPanel filter={parentA} onFilterCommit={filter => { parentA = filter }} />)
    })
    await act(async () => {
      root.render(<StandaloneChatPanel filter={parentB} onFilterCommit={filter => { parentB = filter }} />)
    })
    await act(async () => {
      container.querySelector<HTMLElement>('.fleet-filter-btn')!
        .dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector<HTMLElement>('.fleet-filter-clear')!
        .dispatchEvent(new Event('pointerup', { bubbles: true }))
    })

    assert.deepEqual(parentA, filterA)
    assert.deepEqual(parentB, [])

    await act(async () => root.unmount())
    const reopenedRoot = createRoot(container)
    await act(async () => {
      reopenedRoot.render(<StandaloneChatPanel filter={parentB} onFilterCommit={filter => { parentB = filter }} />)
    })
    await act(async () => {
      container.querySelector<HTMLElement>('.fleet-filter-btn')!
        .dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    assert.match(container.textContent ?? '', /No filter/)
    await act(async () => reopenedRoot.unmount())
  } finally {
    dom.window.close()
    for (const [key, value] of previousGlobals) Reflect.set(globalThis, key, value)
  }
})
