import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'

test('the marking header takes pointer input while the body falls through to the canvas', () => {
  const paneCss = readFileSync(new URL('../src/classroom/AnswerPane.css', import.meta.url), 'utf8')
  const paneSource = readFileSync(new URL('../src/classroom/AnswerPane.tsx', import.meta.url), 'utf8')
  const indexCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
  // The header frame is the smallest unit hit-testing can land on for the
  // controls inside it; without this they inherit `none` from `.bottom-panels`
  // and Return/plus/Send/Layers are unpressable by pointer.
  assert.match(paneCss, /\.tlda-marking-header-pane\s*\{\s*pointer-events:\s*auto;/)
  // The body declines explicitly rather than by inheritance, so wheel and
  // clicks fall through to the glass while marking and to the canvas
  // otherwise — whatever the container's rule becomes.
  assert.match(paneCss, /\.tlda-marking-body-pane\s*\{\s*pointer-events:\s*none;/)
  assert.match(paneSource, /import '\.\/AnswerPane\.css'/)
  assert.match(paneSource, /className="tlda-marking-header-pane"/)
  assert.match(paneSource, /className="tlda-marking-body-pane"/)
  // The header sits above the marking glass (200): with a marking tool armed
  // the glass owns the pen over the whole pair, and a header beneath it would
  // take taps as ink dots. The body stays beneath it, so ink lands on work.
  assert.match(paneSource, /zIndex=\{201\}/)
  assert.match(paneSource, /zIndex=\{marked \? 199 : 198\}/)
  // The controls portal into the header's document, never the body's.
  assert.match(paneSource, /onHeader=\{onHeader\}/)
  assert.match(paneSource, /onHeader=\{null\}/)
  // ... and the container keeps declining, so the panel overlay still falls
  // through to the canvas everywhere else.
  assert.match(indexCss, /\.bottom-panels\s*\{[^}]*pointer-events:\s*none;/)
})

test('the handed-over answer splits at its name header, or renders whole in the header frame', async () => {
  const { window } = new JSDOM('')
  const previous = Reflect.get(globalThis, 'DOMParser')
  Reflect.set(globalThis, 'DOMParser', window.DOMParser)
  try {
    const { splitAnswerMarkup } = await import('../src/classroom/solutionMarking.ts')
    const markup = '<div class="callout callout-answer tlda-marking-answer">'
      + '<div class="tlda-marking-answer-header">ana</div><p>the work itself</p></div>'
    const [header, body] = splitAnswerMarkup(markup)
    assert.ok(header && body, 'a headed answer divides in two')
    assert.match(header, /tlda-marking-answer-header/)
    assert.match(header, /ana/)
    assert.match(header, /<div class="tlda-marking-answer">/, 'the header keeps the callout wrapper its rules match on')
    assert.match(body, /the work itself/)
    assert.doesNotMatch(body, /tlda-marking-answer-header/, 'the name travels with the header, not the work')
    const [fallbackHeader, fallbackBody] = splitAnswerMarkup('<div class="callout"><p>bare</p></div>')
    assert.equal(fallbackBody, null)
    assert.match(fallbackHeader ?? '', /bare/, 'no header: the whole thing renders where the controls live')
  } finally {
    Reflect.set(globalThis, 'DOMParser', previous)
    window.close()
  }
})
