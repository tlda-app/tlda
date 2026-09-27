/**
 * presentationRoute returns a stable reference per pathname.
 *
 * SvgDocumentEditor calls presentationRoute(window.location.pathname) on every
 * render and feeds the result into the presentationDocument useMemo deps. When
 * each call returned a fresh object, the memo recomputed on every render, the
 * SlidesNavigator `document` prop changed identity on every render, and its
 * mount effect re-ran — resetting the deck to slide 1 on any ambient parent
 * re-render (story-2 nondeterministic counter resets, Sep 24). Same input
 * must answer the identical object so value-equal routes memoize.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { presentationRoute } from '../src/presentationRoute.ts'

test('same pathname answers the identical route object', () => {
  const first = presentationRoute('/app/book/decks/chapter-sampling-slides.html')
  const second = presentationRoute('/app/book/decks/chapter-sampling-slides.html')
  assert.ok(first, 'the deck route must parse')
  assert.equal(second, first, 'same pathname must return the same reference, not a fresh object')
})

test('distinct pathnames parse distinctly', () => {
  const deck = presentationRoute('/app/book/decks/chapter-sampling-slides.html')
  const other = presentationRoute('/app/book/decks/chapter-basics-slides.html')
  assert.ok(deck && other)
  assert.notEqual(other, deck)
  assert.equal(deck.location, 'book/decks/chapter-sampling-slides.html')
  assert.equal(other.location, 'book/decks/chapter-basics-slides.html')
  assert.equal(deck.mode, 'app')
})

test('docs-prefixed routes are stable too, non-routes stay null', () => {
  const first = presentationRoute('/docs/qtm285-book/app/book/chapter.html')
  const second = presentationRoute('/docs/qtm285-book/app/book/chapter.html')
  assert.ok(first)
  assert.equal(second, first)
  assert.equal(first.project, 'qtm285-book')
  assert.equal(first.prefix, 'docs')
  assert.equal(presentationRoute('/unrelated/path'), null)
})
