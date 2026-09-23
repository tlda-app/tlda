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
test('the browser measurement keeps slide-level aria-hidden text but still skips node-level hidden text', () => {
  const html = injectBridge('<html><body><main><p>deck line</p></main></body></html>')
  const source = injectedFunction(html, 'tldaMeasureRenderedLines')
  const run = (hiddenAncestor) => {
    const root = { querySelectorAll: () => [block] }
    const textNode = { textContent: 'deck line', parentElement: { closest: () => hiddenAncestor(root) } }
    const block = {
      tagName: 'P',
      id: '',
      textContent: textNode.textContent,
      closest: () => null,
      querySelector: () => null,
    }
    return vm.runInNewContext(`(${source})()`, {
      window: { location: { href: 'https://example.test/deck' } },
      NodeFilter: { SHOW_TEXT: 4 },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      document: {
        title: 'Deck scroll view',
        body: { querySelectorAll: () => [block] },
        querySelector: selector => selector === 'main' ? root : null,
        createTreeWalker: () => {
          let returned = false
          return { nextNode: () => returned ? null : (returned = true, textNode) }
        },
        createRange: () => ({
          setStart: () => {},
          setEnd: () => {},
          getClientRects: () => [{ top: 10, height: 10, width: 20 }],
        }),
      },
      Array,
      Math,
    })
  }
  // Slide-level aria-hidden IS the measured root (scroll-view non-present
  // slide): the single line survives.
  const slideKept = run(root => root)
  assert.equal(slideKept.blocks.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(slideKept.blocks[0].lines)), ['deck line'])
  // Node-level aria-hidden strictly inside the root (MathJax-style rendering):
  // the block is discarded.
  const nodeSkipped = run(() => ({}))
  assert.equal(nodeSkipped.blocks.length, 0)
})

test('the browser measurement roots at the addressed slide when present is stale', () => {
  const html = injectSlidesBridge('<html><head></head><body><div class="reveal"><div class="slides"><section></section></div></div></body></html>')
  const source = injectedFunction(html, 'tldaMeasureRenderedLines')
  const textFor = (text, hiddenAncestor) => ({ textContent: text, parentElement: { closest: () => hiddenAncestor } })
  const blockFor = (tag, text) => ({
    tagName: tag,
    id: '',
    textContent: text,
    closest: () => null,
    querySelector: () => null,
  })
  const run = (reveal) => {
    const titleBlock = blockFor('H1', 'Random Variables and Moments')
    const liBlock = blockFor('LI', 'Observations as random variables with a long second line of prose here')
    const presentSection = { querySelectorAll: () => [titleBlock] }
    const addressedSection = { tagName: 'SECTION', querySelectorAll: () => [liBlock] }
    const titleText = textFor(titleBlock.textContent, null)
    const liText = textFor(liBlock.textContent, addressedSection)
    return vm.runInNewContext(`(${source})()`, {
      ...(reveal === undefined ? {} : { Reveal: reveal(addressedSection) }),
      window: { location: { href: 'https://example.test/deck' } },
      NodeFilter: { SHOW_TEXT: 4 },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      document: {
        title: 'Deck scroll view',
        body: { querySelectorAll: () => [] },
        querySelector: selector => selector === '.reveal .slides section.present' ? presentSection : null,
        createTreeWalker: (block) => {
          let returned = false
          const node = block === liBlock ? liText : titleText
          return { nextNode: () => returned ? null : (returned = true, node) }
        },
        createRange: () => ({
          setStart: () => {},
          setEnd: () => {},
          getClientRects: () => [{ top: 10, height: 10, width: 20 }],
        }),
      },
      Array,
      Math,
    })
  }
  // Addressed slide wins over stale present: the li is measured, the title is not.
  const addressed = run(section => ({ getCurrentSlide: () => section }))
  assert.equal(addressed.blocks.length, 1)
  assert.equal(JSON.parse(JSON.stringify(addressed.blocks[0])).tag, 'li')
  // No Reveal (chapter path): present keeps its old meaning.
  const fallback = run(undefined)
  assert.equal(fallback.blocks.length, 1)
  assert.equal(JSON.parse(JSON.stringify(fallback.blocks[0])).tag, 'h1')
  // Reveal present but failing (pre-init): same fallback, no throw.
  const failing = run(() => ({ getCurrentSlide: () => { throw new Error('not ready') } }))
  assert.equal(failing.blocks.length, 1)
  assert.equal(JSON.parse(JSON.stringify(failing.blocks[0])).tag, 'h1')
})
