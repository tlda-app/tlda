import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { injectBridge } from './html-injector.mjs'

function handlerFor(direction) {
  const html = injectBridge(
    '<html><body><main><p>Chapter</p></main></body></html>',
    '',
    'Chapter',
    false,
    { prev: 'Previous', next: 'Next' },
  )
  const className = direction === 'next' ? 'tlda-nav-next' : 'tlda-nav-prev'
  const match = html.match(new RegExp(`<div class="${className}" onclick="(.+?)"><span`))
  assert.ok(match, `${direction} handler is present`)
  return match[1]
}

for (const direction of ['prev', 'next']) {
  test(`relative ${direction} navigation includes the iframe shape ID`, () => {
    const messages = []
    const window = {
      location: { search: '?_tldaShape=shape%3Abook-page-2' },
      parent: { postMessage: (...args) => messages.push(args) },
    }

    vm.runInNewContext(handlerFor(direction), { URLSearchParams, window })

    assert.equal(messages.length, 1)
    assert.equal(messages[0][1], '*')
    assert.equal(messages[0][0].type, 'tlda-navigate-rel')
    assert.equal(messages[0][0].shapeId, 'shape:book-page-2')
    assert.equal(messages[0][0].direction, direction)
  })
}
