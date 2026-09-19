/**
 * The student's answer as its own document, for the pane beside the chapter.
 *
 * These are string and structure assertions. Whether the result LOOKS like the
 * book's callout is a question for the rendered chapter, and a green run here is
 * not evidence of it — it was checked by hand on `qtm285-course` before this
 * existed, which is what established that carrying the chapter's stylesheets is
 * enough.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const { answerDocumentSrcdoc, answerStyleSources } = await import('../src/classroom/answerDocument')

const windows: JSDOM[] = []
after(() => { for (const w of windows) w.window.close() })

function chapter(head: string) {
  const jsdom = new JSDOM(`<!doctype html><html><head>${head}</head><body class="quarto-light"></body></html>`, {
    url: 'https://example.invalid/docs/course/_book/homework/solutions.html',
  })
  windows.push(jsdom)
  return jsdom.window.document
}

test('the chapter\'s own styling is what gets carried', () => {
  const doc = chapter(`
    <link rel="stylesheet" href="../site_libs/bootstrap/bootstrap.min.css">
    <link rel="stylesheet" href="https://cdn.invalid/quarto.css">
    <style>.callout { border-radius: .25rem }</style>
  `)
  const styles = answerStyleSources(doc)

  // Absolute, because the answer's document is not at the chapter's URL and a
  // relative href would resolve against the app.
  // `../site_libs/…` from `…/_book/homework/solutions.html` resolves inside
  // `_book/`, which is where Quarto puts them.
  assert.deepEqual(styles.stylesheets, [
    'https://example.invalid/docs/course/_book/site_libs/bootstrap/bootstrap.min.css',
    'https://cdn.invalid/quarto.css',
  ])
  assert.deepEqual(styles.inline, ['.callout { border-radius: .25rem }'])
})

// OUR OWN MARKING STYLESHEET MUST NOT TRAVEL.
//
// It positions the answer into the margin of the chapter — `position: absolute;
// left: 100%` — and the answer's document is not that document. Carried across,
// `100%` means the width of the answer's own body and the callout is flung off
// its own right edge. The bug this whole pane exists to fix, arriving inside the
// fix.
test('the marking stylesheet is left behind', () => {
  const doc = chapter('<style id="tlda-marking-style">.tlda-marking-answer { position: absolute; left: 100% }</style>'
    + '<style>.callout { border-radius: .25rem }</style>')

  assert.deepEqual(answerStyleSources(doc).inline, ['.callout { border-radius: .25rem }'])
})

test('the document carries a base, the styles, and the answer', () => {
  const srcdoc = answerDocumentSrcdoc({
    answerHtml: '<div class="callout callout-answer"><p>my answer</p></div>',
    styles: { stylesheets: ['https://example.invalid/quarto.css'], inline: ['.callout { color: red }'] },
    baseHref: 'https://example.invalid/docs/course/_book/homework/solutions.html',
    bodyClass: 'quarto-light',
  })

  // The base is what makes a font or image inside the carried CSS resolve the
  // way it does in the chapter. Without it they resolve against the app's origin
  // and the callout comes back unstyled by a different route.
  assert.match(srcdoc, /<base href="https:\/\/example\.invalid\/docs\/course\/_book\/homework\/solutions\.html">/)
  assert.match(srcdoc, /<link rel="stylesheet" href="https:\/\/example\.invalid\/quarto\.css">/)
  assert.match(srcdoc, /<style>\.callout \{ color: red \}<\/style>/)
  assert.match(srcdoc, /<body class="quarto-light">/)
  assert.match(srcdoc, /<p>my answer<\/p>/)
  // It sits over the canvas: no page-coloured rectangle over the chapter, and no
  // scrollbars of its own.
  assert.match(srcdoc, /background:transparent/)
  assert.match(srcdoc, /overflow:hidden/)
})

test('a quoted url cannot break out of the attribute it sits in', () => {
  const srcdoc = answerDocumentSrcdoc({
    answerHtml: '<p>answer</p>',
    styles: { stylesheets: ['https://example.invalid/x.css?a="><script>alert(1)</script>'], inline: [] },
    baseHref: 'https://example.invalid/"><script>alert(2)</script>',
  })

  assert.doesNotMatch(srcdoc, /<script>/)
  assert.match(srcdoc, /&quot;&gt;&lt;script&gt;/)
})
