import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { injectBridge, injectSlidesBridge } from './html-injector.mjs'

function injectedFunction(html, name) {
  const start = html.indexOf(`function ${name}()`)
  assert.notEqual(start, -1, `${name} is present in the generated bridge`)
  const open = html.indexOf('{', start)
  let depth = 0
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++
    if (html[i] !== '}') continue
    depth--
    if (depth === 0) return html.slice(start, i + 1)
  }
  throw new Error(`${name} has no closing brace`)
}

test('chapter and deck bridges expose settled-DOM line measurement without screenshots', () => {
  for (const html of [
    injectBridge('<html><body><main><p>one two three</p></main></body></html>'),
    injectSlidesBridge('<html><head></head><body><div class="reveal"><div class="slides"><section></section></div></div></body></html>'),
  ]) {
    assert.match(html, /tlda-measure-rendered-lines/)
    assert.match(html, /tlda-rendered-lines/)
    assert.match(html, /document\.fonts\?\.ready/)
    assert.match(html, /requestAnimationFrame/)
    assert.doesNotMatch(html, /screenshot|playwright/i)
  }
})

test('the browser measurement groups words by their rendered rows', () => {
  const html = injectBridge('<html><body><main><p>one two three</p></main></body></html>')
  const source = injectedFunction(html, 'tldaMeasureRenderedLines')
  const textNode = { textContent: 'one two three', parentElement: { closest: () => null } }
  const block = {
    tagName: 'P',
    id: 'sentence',
    textContent: textNode.textContent,
    closest: () => null,
    querySelector: () => null,
  }
  let rangeStart = 0
  const result = vm.runInNewContext(`(${source})()`, {
    window: { location: { href: 'https://example.test/deck' } },
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: {
      title: 'Measured deck',
      body: { querySelectorAll: () => [block] },
      querySelector: selector => selector === 'main' ? { querySelectorAll: () => [block] } : null,
      createTreeWalker: () => {
        let returned = false
        return { nextNode: () => returned ? null : (returned = true, textNode) }
      },
      createRange: () => ({
        setStart: (_node, start) => { rangeStart = start },
        setEnd: () => {},
        getClientRects: () => [{
          top: rangeStart < 8 ? 10 : 30,
          height: 10,
          width: 20,
        }],
      }),
    },
    Array,
    Math,
  })

  assert.deepEqual(JSON.parse(JSON.stringify(result.blocks)), [{
    tag: 'p',
    id: 'sentence',
    text: 'one two three',
    lines: ['one two', 'three'],
  }])
})
