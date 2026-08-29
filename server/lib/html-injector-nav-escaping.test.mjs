// The prev/next chapter links are `onclick` handlers built by string
// concatenation, so the filename goes into a DOUBLE-QUOTED HTML attribute.
// `JSON.stringify` emits its own double quotes, which close the attribute at
// the first one: a parser then sees `onclick="…targetFile:"` and the rest of
// the filename becomes stray attributes. The handler is silently truncated to
// invalid JS and the link does nothing.
//
// This exercises `injectChapterTitle` itself rather than a copy of its
// template. A test that reproduces the markup it is checking can pass while
// the shipped function is broken.
//
// And it asserts on what the handler DOES, not on its source text: a name
// containing a quote appears as \" in the JS, which never string-matches the
// name. Running it and reading the posted payload is the only check that
// distinguishes correct escaping from a plausible-looking attribute.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { injectChapterTitle } from './html-injector.mjs'

/** Undo the HTML attribute encoding a browser would undo before running the handler. */
const decodeAttr = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&')

/** Run one link's onclick the way a browser would, and return what it posted. */
function clickResult(html, which) {
  const anchors = [...html.matchAll(/<a\b[^>]*onclick="([^"]*)"/g)].map((m) => m[1])
  assert.ok(anchors.length >= 1, 'expected at least one anchor with a surviving onclick attribute')
  const attr = decodeAttr(which === 'prev' ? anchors[0] : anchors[anchors.length - 1])

  let posted = null
  const window = { parent: { postMessage: (msg) => { posted = msg } } }
  const event = { preventDefault() {} }
  new Function('window', 'event', attr)(window, event)
  return posted
}

const AWKWARD = [
  'homework/hw-minus-1-setup.html',
  'a "quoted" chapter.html',
  "it's & <odd> chapter.html",
]

for (const name of AWKWARD) {
  test(`prev link posts the exact filename: ${name}`, () => {
    const html = injectChapterTitle('<html><body>x</body></html>', 'Chapter', { name, title: 'Prev' }, null)
    assert.equal(clickResult(html, 'prev').targetFile, name)
  })

  test(`next link posts the exact filename: ${name}`, () => {
    const html = injectChapterTitle('<html><body>x</body></html>', 'Chapter', null, { name, title: 'Next' })
    assert.equal(clickResult(html, 'next').targetFile, name)
  })
}

test('both links survive together and address different chapters', () => {
  const html = injectChapterTitle(
    '<html><body>x</body></html>',
    'Chapter',
    { name: 'one.html', title: 'One' },
    { name: 'two.html', title: 'Two' },
  )
  assert.equal(clickResult(html, 'prev').targetFile, 'one.html')
  assert.equal(clickResult(html, 'next').targetFile, 'two.html')
})

test('the attribute is not truncated: the handler parses as JS', () => {
  const html = injectChapterTitle('<html><body>x</body></html>', 'Chapter', { name: 'a.html', title: 'A' }, null)
  const attr = decodeAttr(html.match(/onclick="([^"]*)"/)[1])
  assert.doesNotThrow(() => new Function(attr), 'onclick was cut short by an unescaped quote')
})
